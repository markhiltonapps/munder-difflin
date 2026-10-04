/**
 * Stapler storage — meeting transcripts on disk, in the MAIN process.
 *
 * One directory, `<root>/stapler/meetings/`, one meeting per id: `<id>.json` is
 * the record the app reads back, `<id>.md` is the same transcript as a document
 * for an agent (or a human) to read. Both are written on every save so the
 * markdown is never stale relative to the JSON.
 *
 * Deliberately free of any `electron` import (the root is passed in) so the
 * module can be exercised as a plain Node module by the tests.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isMeetingId, meetingToMarkdown, normalizeMeeting, summarize,
  type StaplerMeeting, type StaplerMeetingSummary
} from '../shared/stapler';

export class StaplerStore {
  constructor(private readonly root: string) {}

  /** `<root>/stapler/meetings` — created on first write, not at construction. */
  get dir(): string {
    return join(this.root, 'stapler', 'meetings');
  }

  jsonPath(id: string): string { return join(this.dir, `${id}.json`); }
  markdownPath(id: string): string { return join(this.dir, `${id}.md`); }

  /** Newest first. A file that fails to parse is skipped, never fatal. */
  list(): StaplerMeetingSummary[] {
    if (!existsSync(this.dir)) return [];
    const out: StaplerMeetingSummary[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const m = this.get(id);
      if (m) out.push(summarize(m));
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): StaplerMeeting | null {
    if (!isMeetingId(id)) return null;
    const p = this.jsonPath(id);
    if (!existsSync(p)) return null;
    try {
      return normalizeMeeting(JSON.parse(readFileSync(p, 'utf8')), id);
    } catch {
      return null;
    }
  }

  /** Upsert. Returns the markdown path so the caller can hand it to an agent. */
  save(meeting: StaplerMeeting): { ok: true; markdownPath: string } | { ok: false; error: string } {
    const m = normalizeMeeting(meeting, meeting?.id);
    if (!m) return { ok: false, error: 'invalid meeting' };
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.jsonPath(m.id), JSON.stringify(m, null, 2) + '\n', 'utf8');
      writeFileSync(this.markdownPath(m.id), meetingToMarkdown(m), 'utf8');
      return { ok: true, markdownPath: this.markdownPath(m.id) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  delete(id: string): { ok: boolean; error?: string } {
    if (!isMeetingId(id)) return { ok: false, error: 'invalid id' };
    try {
      rmSync(this.jsonPath(id), { force: true });
      rmSync(this.markdownPath(id), { force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
