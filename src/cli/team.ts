import { updateModeState, startMode, readModeState } from '../modes/base.js';
import { monitorTeam, resumeTeam, shutdownTeam, startTeam, type TeamRuntime } from '../team/runtime.js';
import { DEFAULT_MAX_WORKERS } from '../team/state.js';
import { sanitizeTeamName } from '../team/tmux-session.js';
import { parseWorktreeMode, type WorktreeMode } from '../team/worktree.js';
import { routeTaskToRole } from '../team/role-router.js';

interface TeamCliOptions {
  verbose?: boolean;
}

interface ParsedTeamArgs {
  workerCount: number;
  agentType: string;
  explicitAgentType: boolean;
  task: string;
  teamName: string;
  ralph: boolean;
}

const MIN_WORKER_COUNT = 1;

export interface ParsedTeamStartArgs {
  parsed: ParsedTeamArgs;
  worktreeMode: WorktreeMode;
}

function slugifyTask(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'team-task';
}

function parseTeamArgs(args: string[]): ParsedTeamArgs {
  const tokens = [...args];
  let ralph = false;
  let workerCount = 3;
  let agentType = 'executor';
  let explicitAgentType = false;

  if (tokens[0]?.toLowerCase() === 'ralph') {
    ralph = true;
    tokens.shift();
  }

  const first = tokens[0] || '';
  const match = first.match(/^(\d+)(?::([a-z][a-z0-9-]*))?$/i);
  if (match) {
    const count = Number.parseInt(match[1], 10);
    if (!Number.isFinite(count) || count < MIN_WORKER_COUNT || count > DEFAULT_MAX_WORKERS) {
      throw new Error(`Invalid worker count "${match[1]}". Expected ${MIN_WORKER_COUNT}-${DEFAULT_MAX_WORKERS}.`);
    }
    workerCount = count;
    if (match[2]) {
      agentType = match[2];
      explicitAgentType = true;
    }
    tokens.shift();
  }

  const task = tokens.join(' ').trim();
  if (!task) {
    throw new Error('Usage: omx team [ralph] [N:agent-type] "<task description>"');
  }

  const teamName = sanitizeTeamName(slugifyTask(task));
  return { workerCount, agentType, explicitAgentType, task, teamName, ralph };
}

export function parseTeamStartArgs(args: string[]): ParsedTeamStartArgs {
  const parsedWorktree = parseWorktreeMode(args);
  return {
    parsed: parseTeamArgs(parsedWorktree.remainingArgs),
    worktreeMode: parsedWorktree.mode,
  };
}

/**
 * Decompose a compound task string into distinct sub-tasks with role assignments.
 *
 * Decomposition strategy:
 * 1. Numbered list detection: "1. ... 2. ... 3. ..."
 * 2. Conjunction splitting: split on " and ", ", ", "; "
 * 3. Fallback for atomic tasks: create implementation + test + doc sub-tasks
 *
 * When the user specifies an explicit agent-type (e.g., `3:executor`), all tasks
 * get that role (backward compat). Otherwise, heuristic routing assigns roles.
 */
export function decomposeTaskString(
  task: string,
  workerCount: number,
  agentType: string,
  explicitAgentType: boolean,
): Array<{ subject: string; description: string; owner: string; role?: string }> {
  // Try to split the task into distinct sub-goals
  let subtasks = splitTaskString(task);

  // If no decomposition possible, create aspect-scoped sub-tasks for N>1
  if (subtasks.length <= 1 && workerCount > 1) {
    subtasks = createAspectSubtasks(task, workerCount);
  }

  // Assign roles: skip heuristic routing if user specified explicit agent-type
  const tasksWithRoles = subtasks.map((st) => {
    if (explicitAgentType) {
      return { ...st, role: agentType };
    }
    const result = routeTaskToRole(st.subject, st.description, 'team-exec', agentType);
    return { ...st, role: result.role };
  });

  // Distribute tasks across workers
  return distributeTasksToWorkers(tasksWithRoles, workerCount);
}

/** Split a task string into sub-tasks using numbered lists or conjunctions. */
function splitTaskString(task: string): Array<{ subject: string; description: string }> {
  // Try numbered list: "1. foo 2. bar 3. baz" or "1) foo 2) bar"
  const numberedPattern = /(?:^|\s)(\d+)[.)]\s+/g;
  const numberedMatches = [...task.matchAll(numberedPattern)];
  if (numberedMatches.length >= 2) {
    const parts: Array<{ subject: string; description: string }> = [];
    for (let i = 0; i < numberedMatches.length; i++) {
      const prefixLen = numberedMatches[i][0].length;
      const contentStart = numberedMatches[i].index! + prefixLen;
      const end = i + 1 < numberedMatches.length ? numberedMatches[i + 1].index! : task.length;
      const text = task.slice(contentStart, end).trim();
      if (text) {
        parts.push({ subject: text.slice(0, 80), description: text });
      }
    }
    if (parts.length >= 2) return parts;
  }

  // Try conjunction splitting: " and ", ", ", "; "
  // Only split on top-level conjunctions (not inside quoted strings)
  const conjunctionPattern = /(?:,\s+|\s+and\s+|;\s+)/i;
  const parts = task.split(conjunctionPattern).map(s => s.trim()).filter(s => s.length > 0);
  if (parts.length >= 2) {
    return parts.map(p => ({ subject: p.slice(0, 80), description: p }));
  }

  // Single atomic task
  return [{ subject: task.slice(0, 80), description: task }];
}

/** Create aspect-scoped sub-tasks for an atomic task that can't be split. */
function createAspectSubtasks(
  task: string,
  workerCount: number,
): Array<{ subject: string; description: string }> {
  const aspects = [
    { subject: `Implement: ${task}`.slice(0, 80), description: `Implement the core functionality for: ${task}` },
    { subject: `Test: ${task}`.slice(0, 80), description: `Write tests and verify: ${task}` },
    { subject: `Review and document: ${task}`.slice(0, 80), description: `Review code quality and update documentation for: ${task}` },
  ];

  // Return up to workerCount aspects, repeating implementation for extra workers
  const result = aspects.slice(0, workerCount);
  while (result.length < workerCount) {
    const idx = result.length - aspects.length;
    result.push({
      subject: `Additional work (${idx + 1}): ${task}`.slice(0, 80),
      description: `Continue implementation work on: ${task}`,
    });
  }
  return result;
}

/** Distribute tasks across workers, assigning owners round-robin. */
function distributeTasksToWorkers(
  tasks: Array<{ subject: string; description: string; role?: string }>,
  workerCount: number,
): Array<{ subject: string; description: string; owner: string; role?: string }> {
  return tasks.map((t, i) => ({
    ...t,
    owner: `worker-${(i % workerCount) + 1}`,
  }));
}

async function ensureTeamModeState(
  parsed: ParsedTeamArgs,
  tasks?: Array<{ role?: string }>,
): Promise<void> {
  const roleDistribution = tasks && tasks.length > 0
    ? [...new Set(tasks.map(t => t.role ?? parsed.agentType))].join(',')
    : parsed.agentType;

  const existing = await readModeState('team');
  if (existing?.active) {
    await updateModeState('team', {
      task_description: parsed.task,
      current_phase: 'team-exec',
      linked_ralph: parsed.ralph,
      team_name: parsed.teamName,
      agent_count: parsed.workerCount,
      agent_types: roleDistribution,
    });
    return;
  }

  await startMode('team', parsed.task, 50);
  await updateModeState('team', {
    current_phase: 'team-exec',
    linked_ralph: parsed.ralph,
    team_name: parsed.teamName,
    agent_count: parsed.workerCount,
    agent_types: roleDistribution,
  });
}

async function renderStartSummary(runtime: TeamRuntime): Promise<void> {
  console.log(`Team started: ${runtime.teamName}`);
  console.log(`tmux target: ${runtime.sessionName}`);
  console.log(`workers: ${runtime.config.worker_count}`);
  console.log(`agent_type: ${runtime.config.agent_type}`);

  const snapshot = await monitorTeam(runtime.teamName, runtime.cwd);
  if (!snapshot) {
    console.log('warning: team snapshot unavailable immediately after startup');
    return;
  }
  console.log(`tasks: total=${snapshot.tasks.total} pending=${snapshot.tasks.pending} blocked=${snapshot.tasks.blocked} in_progress=${snapshot.tasks.in_progress} completed=${snapshot.tasks.completed} failed=${snapshot.tasks.failed}`);
  if (snapshot.performance) {
    console.log(
      `monitor_perf_ms: total=${snapshot.performance.total_ms} list=${snapshot.performance.list_tasks_ms} workers=${snapshot.performance.worker_scan_ms} mailbox=${snapshot.performance.mailbox_delivery_ms}`
    );
  }
}

export async function teamCommand(args: string[], options: TeamCliOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const parsedWorktree = parseWorktreeMode(args);
  const teamArgs = parsedWorktree.remainingArgs;
  const [subcommandRaw] = teamArgs;
  const subcommand = (subcommandRaw || '').toLowerCase();

  if (subcommand === 'status') {
    const name = teamArgs[1];
    if (!name) throw new Error('Usage: omx team status <team-name>');
    const snapshot = await monitorTeam(name, cwd);
    if (!snapshot) {
      console.log(`No team state found for ${name}`);
      return;
    }
    console.log(`team=${snapshot.teamName} phase=${snapshot.phase}`);
    console.log(`workers: total=${snapshot.workers.length} dead=${snapshot.deadWorkers.length} non_reporting=${snapshot.nonReportingWorkers.length}`);
    console.log(`tasks: total=${snapshot.tasks.total} pending=${snapshot.tasks.pending} blocked=${snapshot.tasks.blocked} in_progress=${snapshot.tasks.in_progress} completed=${snapshot.tasks.completed} failed=${snapshot.tasks.failed}`);
    if (snapshot.performance) {
      console.log(
        `monitor_perf_ms: total=${snapshot.performance.total_ms} list=${snapshot.performance.list_tasks_ms} workers=${snapshot.performance.worker_scan_ms} mailbox=${snapshot.performance.mailbox_delivery_ms}`
      );
    }
    return;
  }

  if (subcommand === 'resume') {
    const name = teamArgs[1];
    if (!name) throw new Error('Usage: omx team resume <team-name>');
    const runtime = await resumeTeam(name, cwd);
    if (!runtime) {
      console.log(`No resumable team found for ${name}`);
      return;
    }
    const existingState = await readModeState('team').catch(() => null);
    const preservedRalph = existingState?.active === true
      && existingState?.team_name === runtime.teamName
      && existingState?.linked_ralph === true;
    await ensureTeamModeState({
      task: runtime.config.task,
      workerCount: runtime.config.worker_count,
      agentType: runtime.config.agent_type,
      explicitAgentType: false,
      teamName: runtime.teamName,
      ralph: preservedRalph,
    });
    await renderStartSummary(runtime);
    return;
  }

  if (subcommand === 'shutdown') {
    const name = teamArgs[1];
    if (!name) throw new Error('Usage: omx team shutdown <team-name> [--force] [--ralph]');
    const force = teamArgs.includes('--force');
    const ralphFlag = teamArgs.includes('--ralph');
    const ralphFromState = !ralphFlag
      ? await readModeState('team').then(
          (s) => s?.active === true && s?.linked_ralph === true && s?.team_name === name,
          () => false,
        )
      : false;
    await shutdownTeam(name, cwd, { force, ralph: ralphFlag || ralphFromState });
    await updateModeState('team', {
      active: false,
      current_phase: 'cancelled',
      completed_at: new Date().toISOString(),
    }).catch((error: unknown) => {
      console.warn('[omx] warning: failed to persist team mode shutdown state', {
        team: name,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    console.log(`Team shutdown complete: ${name}`);
    return;
  }

  const parsed = parseTeamArgs(teamArgs);
  const tasks = decomposeTaskString(parsed.task, parsed.workerCount, parsed.agentType, parsed.explicitAgentType);
  const runtime = await startTeam(
    parsed.teamName,
    parsed.task,
    parsed.agentType,
    parsed.workerCount,
    tasks,
    cwd,
    { worktreeMode: parsedWorktree.mode, ralph: parsed.ralph },
  );

  await ensureTeamModeState(parsed, tasks);
  if (options.verbose) {
    console.log(`linked_ralph=${parsed.ralph}`);
  }
  await renderStartSummary(runtime);
}
