import { expect, it } from 'vitest';
import { managerConfig, managerDue, managerPrompt } from './manager.ts';

it('keeps old configurations disabled and validates PM fields independently', () => {
  expect(managerConfig(undefined).enabled).toBe(false);
  expect(managerConfig({ enabled: true, agent: 'claude' }).agentArgs).toEqual([]);
  for (const bad of [null, [], { enabled: 'true' }, { agent: 'other' }, { agentArgs: [1] },
    { intervalSeconds: 0 }, { maxRunsPerDay: 1.5 }, { timeoutSeconds: -1 }, { instructions: 1 },
    { minIntervalSeconds: 30000 }, { unexpected: true }]) {
    expect(() => managerConfig(bad)).toThrow();
  }
});

it('schedules from completion, limits idle checks and preserves limits across restart/day rollover', () => {
  const config = managerConfig({ enabled: true });
  const now = Date.parse('2026-11-21T12:00:00Z');
  const state = { day: '2026-11-21', runs: 1, lastStartedAt: now, lastFinishedAt: now + 1000 };
  expect(managerDue(config, undefined, now, false)).toBe(true);
  expect(managerDue(config, state, now + 3600_000, true)).toBe(false);
  expect(managerDue(config, state, now + 3601_000, true)).toBe(true);
  expect(managerDue(config, state, now + 3601_000, false)).toBe(false);
  expect(managerDue(config, state, now + 21601_000, false)).toBe(true);
  expect(managerDue(config, { ...state, runs: 4 }, now + 21601_000, true)).toBe(false);
  expect(managerDue(config, { ...state, day: '2026-11-20', runs: 4 }, now + 21601_000, false)).toBe(true);
  expect(managerDue({ ...config, runWhenIdle: false }, state, now + 3601_000, true)).toBe(false);
});

it('builds the PM prompt with the target, previous report and optional extra instructions', () => {
  const prompt = managerPrompt('o/r', 'main', 'M2', '依存を優先', '/state/manager-latest.md');
  expect(prompt).toContain('o/r');
  expect(prompt).toContain('git show origin/main:');
  expect(prompt).toContain('対象マイルストーン: M2');
  expect(prompt).toContain('/state/manager-latest.md');
  expect(prompt).toContain('## 追加の指示\n依存を優先');
  expect(prompt).toContain('docs/roles.md');
  expect(prompt).toContain('npm run decisions -- --update');
  const plain = managerPrompt('o/r', 'main', undefined, '', '/state/manager-latest.md');
  expect(plain).toContain('指定なし');
  expect(plain).not.toContain('追加の指示');
});
