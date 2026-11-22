import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

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

// Validate worker options before acquiring the runner lock or spending a budget.
export function validateWorkerArgs(args: string[]): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== '--model' && !arg.startsWith('--model=')) continue;
    const value = arg === '--model' ? args[++i] : arg.slice('--model='.length);
    if (!value || value !== value.trim() || /^[\"']|[\"']$/.test(value) || value.startsWith('-')) {
      throw new AgentLaunchError('Invalid --model value in agentArgs: remove surrounding whitespace or quotes and provide a model name.');
    }
  }
}

// Only classify structured failures before observable work; incomplete or unparseable
// logs and interrupted processes remain ordinary failures to avoid refunding work.
export async function failedBeforeWork(logfile: string): Promise<boolean> {
  let failed = false;
  let worked = false;
  const lines = createInterface({ input: createReadStream(logfile), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn.failed' || event.type === 'error') failed = true;
      if (event.type === 'item.completed' && ['command_execution', 'file_change', 'mcp_tool_call'].includes(event.item?.type)) worked = true;
      if (event.type === 'assistant' && event.message?.content?.some((block: { type: string }) => block.type === 'tool_use')) worked = true;
    } catch { /* CLI diagnostics can be plain text. */ }
  }
  return failed && !worked;
}
