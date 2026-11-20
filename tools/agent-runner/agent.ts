export function agentArguments(agent: 'codex' | 'claude', extra: string[]): string[] {
  if (agent === 'claude') return ['-p', '--output-format', 'stream-json', '--verbose', ...extra];
  const explicitSandbox = extra.some(arg => arg === '-s' || arg.startsWith('-s=') || arg === '--sandbox' || arg.startsWith('--sandbox='));
  const automatic = extra.includes('--approve-for-me');
  const bypass = extra.includes('--dangerously-bypass-approvals-and-sandbox');
  if (automatic && (explicitSandbox || bypass)) throw new Error('--approve-for-me cannot be combined with --sandbox or sandbox bypass');
  // --approve-for-me selects workspace-write itself; Clap rejects an explicit --sandbox.
  return ['exec', ...(!automatic && !bypass && !explicitSandbox ? ['--sandbox', 'workspace-write'] : []), '--json', ...extra, '-'];
}

export class AgentLaunchError extends Error {}
