import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleTeamWorkerPostToolUseSuccess, teamWorkerPostToolUseInternals } from '../team-worker-posttooluse.js';

async function initWorkerFixture(): Promise<{ cwd: string; stateRoot: string; env: NodeJS.ProcessEnv }> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-posttooluse-worker-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });

  const stateRoot = join(cwd, '.omx', 'state');
  const workerDir = join(stateRoot, 'team', 'demo-team', 'workers', 'worker-1');
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, 'identity.json'), JSON.stringify({
    name: 'worker-1',
    team_state_root: stateRoot,
    worktree_path: cwd,
  }, null, 2), 'utf-8');
  await writeFile(join(stateRoot, 'team', 'demo-team', 'phase.json'), JSON.stringify({ current_phase: 'team-exec' }, null, 2), 'utf-8');
  await writeFile(join(stateRoot, 'team', 'demo-team', 'config.json'), JSON.stringify({ leader_head: 'leader-head' }, null, 2), 'utf-8');
  return {
    cwd,
    stateRoot,
    env: {
      ...process.env,
      OMX_TEAM_WORKER: 'demo-team/worker-1',
      OMX_TEAM_STATE_ROOT: stateRoot,
    },
  };
}

const successPayload = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_response: { exit_code: 0 },
  tool_use_id: 'tool-1',
};

describe('handleTeamWorkerPostToolUseSuccess', () => {
  it('creates a safe worker checkpoint, ledger entries, leader signal, and dedupe marker', async () => {
    const fixture = await initWorkerFixture();
    await writeFile(join(fixture.cwd, 'feature.txt'), 'feature\n', 'utf-8');

    const result = await handleTeamWorkerPostToolUseSuccess(successPayload, fixture.cwd, fixture.env);

    assert.equal(result.handled, true);
    assert.equal(result.status, 'applied');
    assert.ok(result.checkpointCommit);
    assert.deepEqual(result.operationKinds, ['auto_checkpoint', 'leader_integration_attempt']);

    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: fixture.cwd, encoding: 'utf-8' }).trim();
    assert.equal(log, 'omx(team): auto-checkpoint worker-1');

    const eventsRaw = await readFile(join(fixture.stateRoot, 'team', 'demo-team', 'events', 'events.ndjson'), 'utf-8');
    const event = JSON.parse(eventsRaw.trim()) as Record<string, unknown>;
    assert.equal(event.type, 'worker_integration_attempt_requested');
    assert.equal(event.operation_kind, 'leader_integration_attempt');
    assert.equal(event.outcome_status, 'applied');
    assert.equal(event.source, 'posttooluse');
    assert.equal(event.dedupe_key, result.dedupeKey);

    const dedupe = JSON.parse(await readFile(join(fixture.stateRoot, 'team', 'demo-team', 'workers', 'worker-1', 'posttooluse-dedupe.json'), 'utf-8')) as { keys: string[] };
    assert.equal(dedupe.keys.includes(result.dedupeKey!), true);

    const ledger = JSON.parse(await readFile(join(fixture.cwd, '.omx', 'reports', 'team-commit-hygiene', 'demo-team.ledger.json'), 'utf-8')) as { entries: Array<{ operation: string; status: string }> };
    assert.equal(ledger.entries.some((entry) => entry.operation === 'auto_checkpoint' && entry.status === 'applied'), true);
    assert.equal(ledger.entries.some((entry) => entry.operation === 'leader_integration_attempt' && entry.status === 'applied'), true);
  });

  it('records noop without creating a checkpoint commit', async () => {
    const fixture = await initWorkerFixture();
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.cwd, encoding: 'utf-8' }).trim();

    const result = await handleTeamWorkerPostToolUseSuccess(successPayload, fixture.cwd, fixture.env);

    const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.cwd, encoding: 'utf-8' }).trim();
    assert.equal(result.status, 'noop');
    assert.equal(result.checkpointCommit, null);
    assert.equal(after, before);
  });

  it('skips protected runtime-only changes', async () => {
    const fixture = await initWorkerFixture();
    await writeFile(join(fixture.cwd, 'AGENTS.md'), 'generated worker instructions\n', 'utf-8');

    const result = await handleTeamWorkerPostToolUseSuccess(successPayload, fixture.cwd, fixture.env);

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'only_protected_paths_changed');
    assert.equal(result.checkpointCommit, null);
  });

  it('exports canonical dedupe and protected-path helpers for fallback suppression', () => {
    const key = teamWorkerPostToolUseInternals.buildDedupeKey({
      teamName: 'team',
      workerName: 'worker-1',
      workerHeadBefore: 'before',
      workerHeadAfter: 'after',
      checkpointCommit: 'checkpoint',
      leaderHeadObserved: 'leader',
      operationKind: 'leader_integration_attempt',
      outcomeStatus: 'applied',
    });
    assert.equal(key, 'team|worker-1|before|after|checkpoint|leader|leader_integration_attempt|applied');
    assert.equal(teamWorkerPostToolUseInternals.isProtectedCheckpointPath('.omx/state/team/x'), true);
    assert.equal(teamWorkerPostToolUseInternals.isProtectedCheckpointPath('src/index.ts'), false);
  });

  it('fails closed for missing worker identity without guessed state writes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-posttooluse-missing-identity-'));
    const result = await handleTeamWorkerPostToolUseSuccess(successPayload, cwd, {
      ...process.env,
      OMX_TEAM_WORKER: 'demo-team/worker-1',
      OMX_TEAM_STATE_ROOT: join(cwd, '.omx', 'state'),
    });

    assert.equal(result.handled, false);
    assert.equal(result.status, 'skipped');
    assert.equal(existsSync(join(cwd, '.omx', 'state', 'team')), false);
  });
});
