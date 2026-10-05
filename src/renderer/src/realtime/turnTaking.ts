/**
 * Realtime Michael — turn-taking policy (pure; no DOM, no SDK).
 *
 * Three things decide whether a voice conversation feels fluid or choppy:
 *
 *   1. HOW SOON the model takes its turn after you pause (`pace`), mapped onto
 *      the Realtime API's semantic-VAD eagerness.
 *   2. WHETHER the mic can cut the model off mid-sentence (`bargeIn`). On
 *      speakers, a cough or the model's own voice leaking back into the mic
 *      counts as "the user started talking" and truncates the reply — the
 *      classic stall-and-stop.
 *   3. WHEN background context lands. Floor updates and task completions used
 *      to be injected the moment they arrived, mid-reply included. The
 *      DeliveryGate below holds them while anyone is talking and delivers them
 *      in one batch once the line is quiet.
 *
 * Everything here is deterministic and takes its clock/timers by injection so
 * the tests can drive it without a session.
 */

export type RealtimePace = 'eager' | 'balanced' | 'patient';

export const REALTIME_PACES: RealtimePace[] = ['eager', 'balanced', 'patient'];
export const DEFAULT_PACE: RealtimePace = 'balanced';

export interface TurnDetection {
  type: 'semantic_vad';
  eagerness: 'low' | 'medium' | 'high';
  createResponse: true;
  interruptResponse: boolean;
}

export function normalizePace(v: unknown): RealtimePace {
  return v === 'eager' || v === 'patient' || v === 'balanced' ? v : DEFAULT_PACE;
}

/** The session's turn-detection block for a pace + barge-in choice. */
export function turnDetectionFor(pace: unknown, bargeIn: unknown): TurnDetection {
  const p = normalizePace(pace);
  return {
    type: 'semantic_vad',
    eagerness: p === 'eager' ? 'high' : p === 'patient' ? 'low' : 'medium',
    createResponse: true,
    interruptResponse: bargeIn !== false
  };
}

/** Floor deltas are each a short parenthetical sentence already; batching joins
 *  them so one silent item carries the whole quiet-period backlog. */
export const MAX_BATCH_CHARS = 1_200;

export function coalesceFloorDeltas(deltas: string[]): string | null {
  const parts = deltas.map((d) => d.trim()).filter(Boolean);
  if (!parts.length) return null;
  let body = parts.join(' · ');
  if (body.length > MAX_BATCH_CHARS) body = `${body.slice(0, MAX_BATCH_CHARS - 1)}…`;
  const head = parts.length === 1 ? 'Floor update' : `Floor updates (${parts.length})`;
  return `(${head}: ${body}. Mention these only when relevant — don't interrupt.)`;
}

export function coalesceCompletions(summaries: string[]): string | null {
  const parts = summaries.map((d) => d.trim()).filter(Boolean);
  if (!parts.length) return null;
  let body = parts.join(' Next: ');
  if (body.length > MAX_BATCH_CHARS) body = `${body.slice(0, MAX_BATCH_CHARS - 1)}…`;
  const head = parts.length === 1
    ? 'a task you dispatched just finished'
    : `${parts.length} tasks you dispatched just finished`;
  return `(System notification — ${head}: ${body}) Briefly let the user know, and offer details if they want them.`;
}

export interface DeliveryGateOptions {
  /** Append a conversation item WITHOUT triggering a reply (floor context). */
  injectSilent: (text: string) => void;
  /** Append a conversation item AND have the model speak (completions). */
  speak: (text: string) => void;
  /** Quiet time after the last activity before a batch goes out, so the user
   *  gets first claim on the turn. Default 1500 ms. */
  settleMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * Holds background context while the line is busy and releases it in one batch
 * once it has been quiet for `settleMs`. "Busy" is any of: the model has a
 * response in flight, its audio is still playing, a tool is running, or the
 * user is speaking.
 */
export class DeliveryGate {
  private responding = false;
  private audioPlaying = false;
  private toolRunning = false;
  private userSpeaking = false;
  private floor: string[] = [];
  private completions: string[] = [];
  private timer: unknown = null;
  private disposed = false;
  private readonly settleMs: number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (handle: unknown) => void;

  constructor(private readonly opts: DeliveryGateOptions) {
    this.settleMs = opts.settleMs ?? 1_500;
    this.setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get busy(): boolean {
    return this.responding || this.audioPlaying || this.toolRunning || this.userSpeaking;
  }

  get pending(): number {
    return this.floor.length + this.completions.length;
  }

  /** Feed raw transport events; the ones that mark a turn boundary are read
   *  here. Playback is tracked from the WebRTC output buffer, not from the
   *  generation events: over WebRTC the model finishes GENERATING a reply a
   *  good while before the user has finished HEARING it. */
  onTransportEvent(type: string | undefined): void {
    switch (type) {
      case 'response.created': this.responding = true; break;
      case 'response.done':
      case 'response.cancelled': this.responding = false; break;
      case 'input_audio_buffer.speech_started': this.userSpeaking = true; break;
      case 'input_audio_buffer.speech_stopped': this.userSpeaking = false; break;
      case 'output_audio_buffer.started': this.audioPlaying = true; break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared': this.audioPlaying = false; break;
      default: return;
    }
    this.reschedule();
  }

  /** Playback override (barge-in truncation, or a transport without buffer events). */
  setAudioPlaying(on: boolean): void { this.audioPlaying = on; this.reschedule(); }
  setToolRunning(on: boolean): void { this.toolRunning = on; this.reschedule(); }

  floorDelta(text: string): void {
    if (this.disposed || !text.trim()) return;
    this.floor.push(text);
    this.reschedule();
  }

  completion(summary: string): void {
    if (this.disposed || !summary.trim()) return;
    this.completions.push(summary);
    this.reschedule();
  }

  /** Deliver whatever is queued right now, regardless of state. */
  flush(): void {
    this.cancelTimer();
    if (this.disposed) return;
    const floor = coalesceFloorDeltas(this.floor);
    const done = coalesceCompletions(this.completions);
    this.floor = [];
    this.completions = [];
    // Context first so the spoken notice can lean on it.
    if (floor) { try { this.opts.injectSilent(floor); } catch { /* best-effort */ } }
    if (done) { try { this.opts.speak(done); } catch { /* best-effort */ } }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.floor = [];
    this.completions = [];
  }

  /** Any state change re-arms the settle timer; it only ever fires when the
   *  line has been quiet for the whole window and something is waiting. */
  private reschedule(): void {
    this.cancelTimer();
    if (this.disposed || this.busy || this.pending === 0) return;
    this.timer = this.setT(() => {
      this.timer = null;
      if (this.busy) return; // became busy again before the timer fired
      this.flush();
    }, this.settleMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) { this.clearT(this.timer); this.timer = null; }
  }
}

/** Short spoken fillers Michael's voice plays the instant a tool call starts,
 *  so a look-up never sounds like dead air. Hardcoded, generated once per
 *  machine via text-to-speech in Michael's voice and cached. */
export const TOOL_FILLERS: readonly string[] = [
  'One sec, let me check.',
  'Let me pull that up.',
  'Checking the floor now.',
  'Hang on, looking.',
  'Give me a second.'
];

export function pickFiller(rand: () => number = Math.random): string {
  return TOOL_FILLERS[Math.min(TOOL_FILLERS.length - 1, Math.floor(rand() * TOOL_FILLERS.length))];
}
