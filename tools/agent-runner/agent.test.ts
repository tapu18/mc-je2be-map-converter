import { expect, it } from 'vitest';
import { agentArguments } from './agent.ts';

it('does not combine Codex automatic approval with an explicit sandbox', () => {
  const args = agentArguments('codex', ['--approve-for-me']);
  expect(args).toContain('--approve-for-me');
  expect(args).not.toContain('--sandbox');
  expect(args.at(-1)).toBe('-');
  expect(agentArguments('codex', [])).toContain('workspace-write');
  expect(agentArguments('codex', ['--sandbox=read-only'])).not.toContain('--sandbox');
  expect(() => agentArguments('codex', ['--approve-for-me', '--sandbox', 'workspace-write'])).toThrow('cannot be combined');
});
