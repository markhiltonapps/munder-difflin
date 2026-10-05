/**
 * Stapler — meeting transcripts, shared between main (storage) and the renderer
 * (capture + UI). Data shapes and the pure transforms over them. No Electron,
 * no DOM, so both sides and the tests can load it.
 */

/** Who a segment belongs to. 'you' is the microphone; 'them' is the system
 *  audio loopback (the other side of the call). */
export type StaplerSpeaker = 'you' | 'them';

export interface StaplerSegment {
  id: string;
  who: StaplerSpeaker;
  /** Seconds from the meeting start at which this chunk began / ended. */
  t0: number;
  t1: number;
  text: string;
}

export interface StaplerMeeting {
  id: string;
  title: string;
  /** What the human wrote about the meeting — travels with the transcript when
   *  it is sent to an agent. */
  description: string;
  startedAt: string;
  endedAt?: string;
  /** Whether the system-audio side was captured. False on platforms without
   *  loopback capture, or when the user declined it. */
  themCaptured: boolean;
  segments: StaplerSegment[];
}

/** List rows: everything but the segments, plus a count. */
export interface StaplerMeetingSummary {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  segmentCount: number;
}

/** A meeting id is a filename, so it is minted here and validated on both
 *  sides: timestamp + random suffix, lowercase, no separators. */
export const MEETING_ID_RE = /^[a-z0-9-]{8,64}$/;

export function isMeetingId(id: unknown): id is string {
  return typeof id === 'string' && MEETING_ID_RE.test(id);
}

export function newMeetingId(now: Date = new Date(), rand: string = Math.random().toString(36).slice(2, 8)): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '').toLowerCase();
  return `m-${stamp}-${rand.replace(/[^a-z0-9]/g, '').slice(0, 6) || '0'}`;
}

/** Default title: the date and time the meeting started, so an untitled
 *  meeting still reads as something in the list. */
export function defaultTitle(startedAt: string): string {
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return 'Meeting';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `Meeting ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Whisper on silence is not silent: it produces "Thank you.", "you", a lone
 *  period, or a subtitle credit. A chunk whose whole transcript is one of these
 *  is dropped before it reaches the transcript. The list is deliberately short
 *  and exact — a real "Thank you." mid-conversation is one of hundreds of
 *  segments, while the phantom one repeats on every silent chunk. */
const PHANTOMS = new Set([
  '', '.', '..', '...', 'you', 'you.', 'thank you', 'thank you.', 'thanks.', 'thanks for watching',
  'thanks for watching.', 'thank you for watching', 'thank you for watching.', 'bye.', 'bye', 'the end',
  'the end.', 'subtitles by the amara.org community', '[music]', '[blank_audio]', '[silence]', '(silence)',
  '[ silence ]', '[inaudible]'
]);

export function isPhantomTranscript(text: string): boolean {
  const norm = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return PHANTOMS.has(norm);
}

/** Chronological, by start time; ties keep You before Them so a simultaneous
 *  pair reads in a stable order. */
export function sortSegments(segments: StaplerSegment[]): StaplerSegment[] {
  return [...segments].sort((a, b) => a.t0 - b.t0 || (a.who === b.who ? 0 : a.who === 'you' ? -1 : 1));
}

export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

/** The transcript as a markdown document: what gets written beside the JSON,
 *  and what an agent reads. Consecutive segments from one speaker are merged
 *  into a paragraph so the file reads as dialogue rather than as 20-second
 *  slices. */
export function meetingToMarkdown(m: StaplerMeeting, labels: { you: string; them: string } = { you: 'You', them: 'Them' }): string {
  const lines: string[] = [];
  lines.push(`# ${m.title || defaultTitle(m.startedAt)}`);
  lines.push('');
  lines.push(`- Started: ${m.startedAt}`);
  if (m.endedAt) lines.push(`- Ended: ${m.endedAt}`);
  lines.push(`- Sides: ${m.themCaptured ? `${labels.you} (microphone) and ${labels.them} (system audio)` : `${labels.you} (microphone) only`}`);
  if (m.description.trim()) {
    lines.push('');
    lines.push('## Description');
    lines.push('');
    lines.push(m.description.trim());
  }
  lines.push('');
  lines.push('## Transcript');
  lines.push('');
  let last: StaplerSpeaker | null = null;
  let para: string[] = [];
  let paraStart = 0;
  const flush = (): void => {
    if (!last || para.length === 0) return;
    lines.push(`**${labels[last]}** _(${fmtClock(paraStart)})_`);
    lines.push('');
    lines.push(para.join(' '));
    lines.push('');
    para = [];
  };
  for (const seg of sortSegments(m.segments)) {
    const text = seg.text.trim();
    if (!text) continue;
    if (seg.who !== last) { flush(); last = seg.who; paraStart = seg.t0; }
    para.push(text);
  }
  flush();
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

/** The message queued to an agent: short, with the path to the full transcript
 *  and the human's description and instruction. The transcript itself stays on
 *  disk — typing twenty minutes of dialogue into a TUI prompt is not how an
 *  agent should receive it, and the file is one `Read` away. */
export function agentMessageFor(m: StaplerMeeting, markdownPath: string, instruction: string): string {
  const parts: string[] = [];
  parts.push(`Meeting transcript: "${m.title || defaultTitle(m.startedAt)}" — ${m.segments.length} segments, ${m.themCaptured ? 'both sides' : 'my side only'}.`);
  parts.push(`Full transcript (markdown): ${markdownPath}`);
  if (m.description.trim()) parts.push(`About this meeting: ${m.description.trim()}`);
  parts.push(instruction.trim() || 'Read the transcript, summarise the decisions and action items, and tell me what you need from me.');
  return parts.join('\n');
}

/** Whisper's `prompt` is a spelling hint, not an instruction: a comma-separated
 *  list of names and terms it should recognise. Built from the vocabulary the
 *  user keeps in Settings, one term per line or comma. Capped — the API ignores
 *  anything past its window, and a huge prompt only slows the upload. */
export function vocabularyPrompt(vocabulary: string | undefined, max = 600): string | undefined {
  if (!vocabulary) return undefined;
  const terms = vocabulary.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  if (terms.length === 0) return undefined;
  let out = '';
  for (const term of terms) {
    const next = out ? `${out}, ${term}` : term;
    if (next.length > max) break;
    out = next;
  }
  return out || undefined;
}

export function summarize(m: StaplerMeeting): StaplerMeetingSummary {
  return { id: m.id, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt, segmentCount: m.segments.length };
}

/** Defensive parse of a meeting read back from disk: unknown shapes become a
 *  valid empty meeting rather than a crash in the list. */
export function normalizeMeeting(raw: unknown, fallbackId: string): StaplerMeeting | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = isMeetingId(r.id) ? r.id : fallbackId;
  if (!isMeetingId(id)) return null;
  const segments: StaplerSegment[] = Array.isArray(r.segments)
    ? r.segments.flatMap((s) => {
        if (!s || typeof s !== 'object') return [];
        const seg = s as Record<string, unknown>;
        if (typeof seg.text !== 'string') return [];
        const who: StaplerSpeaker = seg.who === 'them' ? 'them' : 'you';
        const t0 = typeof seg.t0 === 'number' && Number.isFinite(seg.t0) ? seg.t0 : 0;
        const t1 = typeof seg.t1 === 'number' && Number.isFinite(seg.t1) ? seg.t1 : t0;
        return [{ id: typeof seg.id === 'string' ? seg.id : `${who}-${t0}`, who, t0, t1, text: seg.text }];
      })
    : [];
  const startedAt = typeof r.startedAt === 'string' ? r.startedAt : new Date(0).toISOString();
  return {
    id,
    title: typeof r.title === 'string' ? r.title : '',
    description: typeof r.description === 'string' ? r.description : '',
    startedAt,
    endedAt: typeof r.endedAt === 'string' ? r.endedAt : undefined,
    themCaptured: r.themCaptured === true,
    segments
  };
}

/** Why the system-audio ("Them") side could not be captured. */
export type ThemFailure = 'gesture' | 'denied' | 'no-audio' | 'unsupported' | 'error';

/** Read a getDisplayMedia failure into something the owner can act on. The
 *  browser requires a fresh click ("transient activation") before it will hand
 *  out system audio; a request started from a hotkey or another window has
 *  none, which is the usual reason the other side goes missing on Windows. */
export function classifyThemFailure(err: unknown): ThemFailure {
  const name = (err && typeof err === 'object' && 'name' in err) ? String((err as { name: unknown }).name) : '';
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (name === 'InvalidStateError' || msg.includes('gesture') || msg.includes('activation')) return 'gesture';
  if (name === 'NotAllowedError' || name === 'SecurityError' || msg.includes('permission') || msg.includes('denied')) return 'denied';
  if (name === 'NotSupportedError' || name === 'TypeError' || msg.includes('not supported')) return 'unsupported';
  return 'error';
}
