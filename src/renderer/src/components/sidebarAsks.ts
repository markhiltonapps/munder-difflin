/**
 * Pure helpers behind the office sidebar — kept free of React and of the store
 * so `test/office-sidebar.test.cjs` can load them through load-ts and pin the
 * rules down.
 */

/** The slice of a hive task the sidebar reads. Structurally compatible with
 *  TasksKanban's HiveTask; declared here so this module stays dependency-free. */
export interface SidebarTask {
  id?: string;
  status?: string;
  assignee?: string;
  humanQA?: Array<{ q?: unknown; a?: unknown; dismissedAt?: unknown } | null | undefined>;
}

/** Same predicate as TasksKanban.waitsOnHuman: blocked with an unanswered,
 *  undismissed question on the card. Duplicated rather than imported so a
 *  change there is a conscious change here too — the sidebar badge and the
 *  ASK ME board must agree on what "asked you" means. */
export function taskWaitsOnHuman(t: SidebarTask): boolean {
  if (t.status !== 'blocked' || !Array.isArray(t.humanQA)) return false;
  for (let i = t.humanQA.length - 1; i >= 0; i--) {
    const e = t.humanQA[i];
    if (e && typeof e.q === 'string' && !e.a && !e.dismissedAt) return true;
  }
  return false;
}

/** Open asks per agent id. A card with no assignee is the orchestrator's own
 *  question (it wrote the card), so it lands on `godId` — never dropped, or the
 *  Inbox count and the per-row chips would disagree. */
export function asksByAgent(tasks: SidebarTask[], godId: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tasks) {
    if (!t || !taskWaitsOnHuman(t)) continue;
    const owner = (typeof t.assignee === 'string' && t.assignee) ? t.assignee : godId;
    if (!owner) continue;
    out[owner] = (out[owner] ?? 0) + 1;
  }
  return out;
}

/** Tasks each agent is actively DOING, keyed by assignee — the sticky-note
 *  count the floor strip already shows, so the two surfaces never disagree. */
export function doingByAgent(tasks: SidebarTask[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of tasks) {
    if (t?.status === 'doing' && typeof t.assignee === 'string' && t.assignee && typeof t.id === 'string') {
      (out[t.assignee] = out[t.assignee] ?? []).push(t.id);
    }
  }
  return out;
}

/** What the sidebar search reads on each agent. */
export interface SearchableAgent {
  name: string;
  project?: string;
  description?: string;
  note?: string;
}

/** Case-insensitive match over the name, project, job description and the
 *  private note. Every query word must hit SOMEWHERE (not necessarily the same
 *  field), so "api dwight" finds Dwight on the api repo. An empty query matches
 *  everyone. */
export function matchesSidebarQuery(agent: SearchableAgent, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [agent.name, agent.project ?? '', agent.description ?? '', agent.note ?? '']
    .join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The one line under an agent's name. The action while it is working; the
 *  tail of what it last said while it is not (that is the "live line": you
 *  can see where every agent left off without opening it); the project when
 *  it has said nothing yet. */
export function liveLineFor(agent: {
  status: string; action?: string; recentAssistantText?: string; project?: string;
}): string {
  if (agent.status !== 'idle' && agent.action) return agent.action;
  const said = (agent.recentAssistantText ?? '').trim();
  if (said) {
    // Last non-empty line: the end of a message is where the conclusion sits.
    const lines = said.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? '';
  }
  return agent.project ?? '';
}
