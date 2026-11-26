export interface Issue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string }[];
  comments: { body: string }[];
}

export interface PullRequest {
  number: number;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  mergeStateStatus: string;
  reviewDecision: string;
  labels: { name: string }[];
  closingIssuesReferences: { number: number }[];
  statusCheckRollup: {
    name?: string;
    context?: string;
    status?: string;
    conclusion?: string;
    state?: string;
  }[];
}

export interface WorkflowRun {
  headSha: string;
  event: string;
  status: string;
  conclusion: string | null;
}

export function hasLabel(issue: Pick<Issue, 'labels'>, name: string): boolean {
  return issue.labels.some(label => label.name === name);
}

// Only explicit dependency fields count; ordinary references in background text do not.
export function dependencies(body: string): number[] {
  const result = new Set<number>();
  let section = false;
  for (const line of body.split('\n')) {
    if (/^#{1,6}\s/.test(line)) section = /^#{1,6}\s+(依存|Dependencies)\s*$/i.test(line.trim());
    if (section || /^(?:Depends on|依存)\s*[:：]/i.test(line.trim())) {
      for (const match of line.matchAll(/#(\d+)\b/g)) result.add(Number(match[1]));
    }
  }
  return [...result];
}

export function activeClaims(comments: Issue['comments']): string[] {
  const claims = new Set<string>();
  for (const comment of comments) {
    for (const line of comment.body.split('\n')) {
      const claim = /^claim:\s*(\S+)/.exec(line);
      const cancelled = /^claim-cancelled:\s*(\S+)/.exec(line);
      if (claim?.[1]) claims.add(claim[1]);
      if (cancelled?.[1]) claims.delete(cancelled[1]);
    }
  }
  return [...claims];
}

export function isDependencyBlocked(item: Pick<Issue, 'labels'> & { body: string | null }): boolean {
  return hasLabel(item, 'status:blocked') && !hasLabel(item, 'needs-approval') &&
    !item.labels.some(l => l.name.startsWith('status:') && l.name !== 'status:blocked') &&
    !/^[ \t]*Blocked[ \t]*[:：]/im.test(item.body ?? '');
}

export function failedChecks(pr: PullRequest): string[] {
  return pr.statusCheckRollup.filter(check =>
    ['FAILURE', 'ERROR', 'failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(check.conclusion ?? check.state ?? ''))
    .map(check => check.name ?? check.context ?? '名前不明のチェック');
}

export function checksFailed(pr: PullRequest): boolean {
  return failedChecks(pr).length > 0;
}

export function canMerge(issue: Issue, pr: PullRequest, base: string, runs: WorkflowRun[]): boolean {
  if (issue.state !== 'OPEN' || hasLabel(issue, 'needs-approval') || hasLabel(issue, 'status:blocked') ||
      hasLabel(issue, 'status:paused') || hasLabel(pr, 'needs-approval')) return false;
  if (pr.state !== 'OPEN' || pr.isDraft || pr.baseRefName !== base || pr.mergeStateStatus !== 'CLEAN' ||
      pr.reviewDecision === 'CHANGES_REQUESTED' || !pr.closingIssuesReferences.some(ref => ref.number === issue.number)) return false;
  // Runs are newest first. Do not accept a previous success when a rerun is pending or failed.
  const run = runs.find(run => run.headSha === pr.headRefOid && run.event === 'pull_request');
  if (!run || run.status !== 'completed' || run.conclusion !== 'success' || !pr.statusCheckRollup.length) return false;
  return pr.statusCheckRollup.every(check => check.status
    ? check.status === 'COMPLETED' && ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion ?? '')
    : check.state === 'SUCCESS');
}

// A missing result is not evidence of a healthy base. Cancelled runs do not supersede
// the most recent completed, non-cancelled push run.
export function latestBaseRun(runs: WorkflowRun[]): WorkflowRun | undefined {
  return runs.find(run => run.event === 'push' && run.status === 'completed' && run.conclusion !== 'cancelled');
}

export function baseAllowsMerge(runs: WorkflowRun[], baseChanges: string[], prChanges: string[]): boolean {
  const run = latestBaseRun(runs);
  return run?.conclusion === 'success' && !baseChanges.some(path => prChanges.includes(path));
}
