/**
 * Stapler session — the one meeting recorder for the whole renderer.
 *
 * Two sides, two streams:
 *   You  — getUserMedia(audio): the microphone.
 *   Them — getDisplayMedia(audio): the system-audio loopback that main's
 *          display-media handler answers with (Windows). Where loopback is not
 *          available the request comes back without an audio track and the
 *          meeting is recorded one-sided, which the state says plainly.
 *
 * Each side is chunked: a MediaRecorder is rotated every CHUNK_MS so every
 * chunk is a complete, standalone webm (a timeslice'd recorder emits fragments
 * that only decode as a sequence — useless for per-chunk transcription). A chunk
 * goes to Groq over IPC the moment it closes, and its transcript lands in the
 * meeting as a segment stamped with the chunk's start/end offsets. Both sides'
 * segments interleave by time, which is what makes the transcript a dialogue.
 *
 * Silence is the enemy twice over: it costs an upload and Whisper hallucinates
 * on it. A level gate per side (AnalyserNode peak over the chunk) skips chunks
 * nobody spoke in, and a short phantom list drops the "Thank you." a quiet
 * chunk still produces.
 *
 * Module singleton + `useStapler()` (useSyncExternalStore), the Free Flow
 * recorder's shape, so a tab switch never interrupts a meeting: the UI
 * subscribes, it does not own.
 */
import { useSyncExternalStore } from 'react';
import { useStore } from '@/store/store';
import {
  agentMessageFor, defaultTitle, isPhantomTranscript, newMeetingId,
  type StaplerMeeting, type StaplerSegment, type StaplerSpeaker, classifyThemFailure, type ThemFailure } from '@shared/stapler';

export type StaplerStatus = 'idle' | 'starting' | 'recording' | 'stopping';

export interface StaplerState {
  status: StaplerStatus;
  /** The meeting on screen: live while recording, the finished one after stop,
   *  or a past one loaded from the list. Null when nothing is open. */
  meeting: StaplerMeeting | null;
  /** Chunks uploaded and not yet answered. Non-zero after stop means the last
   *  words are still on their way. */
  pending: number;
  /** Seconds since the meeting started; ticks once a second while recording. */
  elapsed: number;
  /** Did the other side get captured this meeting? Null before the first start. */
  themAvailable: boolean | null;
  /** When it was not: why, so the owner knows what to change. */
  themFailure: ThemFailure | null;
  /** Last error. Capture errors stop the meeting; a transcription error does
   *  not (the next chunk may well succeed), it is just shown. */
  error: string | null;
  /** Where the markdown for the current meeting was last written. */
  markdownPath: string | null;
}

let state: StaplerState = {
  status: 'idle', meeting: null, pending: 0, elapsed: 0, themAvailable: null, themFailure: null, error: null, markdownPath: null
};
const listeners = new Set<() => void>();
function setState(patch: Partial<StaplerState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): StaplerState { return state; }

/** Chunk length. Long enough that Whisper has context and the per-chunk
 *  overhead is small, short enough that the transcript trails the call by
 *  under half a minute. */
const CHUNK_MS = 20_000;
/** Peak sample (0..1) a chunk must reach to be worth transcribing. Opus of
 *  room tone peaks around 0.005; a quiet voice at arm's length around 0.05. */
const LEVEL_FLOOR = 0.015;

function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
    for (const c of candidates) if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

/**
 * One side's rotating recorder. `onChunk` receives every closed chunk with its
 * offsets and the peak level seen while it recorded; the caller decides what to
 * do with a quiet one.
 */
class ChunkRecorder {
  /** The chunk being recorded right now. `peak` is written by the level meter
   *  only while the record is current, so a closed chunk's reading is frozen
   *  by the time its `onstop` fires. */
  private current: { rec: MediaRecorder; chunks: Blob[]; startMs: number; peak: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  /** Without a working meter every chunk counts as loud, so nothing is skipped. */
  private metered = false;
  private stopped = false;
  private readonly mimeType = pickMimeType();

  constructor(
    private readonly stream: MediaStream,
    private readonly meetingStartMs: number,
    private readonly onChunk: (blob: Blob, t0: number, t1: number, peak: number) => void
  ) {}

  start(): void {
    // Level meter. Best-effort: if the AudioContext cannot be built the gate
    // reports a peak of 1 and every chunk is transcribed.
    try {
      this.audioCtx = new AudioContext();
      const src = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      src.connect(this.analyser);
      const buf = new Uint8Array(this.analyser.fftSize);
      this.metered = true;
      this.levelTimer = setInterval(() => {
        if (!this.analyser || !this.current) return;
        this.analyser.getByteTimeDomainData(buf);
        let max = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = Math.abs((buf[i] - 128) / 128);
          if (v > max) max = v;
        }
        if (max > this.current.peak) this.current.peak = max;
      }, 150);
    } catch {
      this.metered = false;
    }
    this.openRecorder();
    this.timer = setInterval(() => this.rotate(), CHUNK_MS);
  }

  /** Close the current chunk and open the next on the same stream. */
  private rotate(): void {
    const closing = this.current;
    this.current = null;
    try { closing?.rec.stop(); } catch { /* already stopped */ }
    if (!this.stopped) this.openRecorder();
  }

  private openRecorder(): void {
    const rec = this.mimeType ? new MediaRecorder(this.stream, { mimeType: this.mimeType }) : new MediaRecorder(this.stream);
    const record = { rec, chunks: [] as Blob[], startMs: Date.now(), peak: this.metered ? 0 : 1 };
    rec.ondataavailable = (ev: BlobEvent) => { if (ev.data && ev.data.size > 0) record.chunks.push(ev.data); };
    rec.onstop = () => {
      const blob = new Blob(record.chunks, { type: rec.mimeType || 'audio/webm' });
      const t0 = (record.startMs - this.meetingStartMs) / 1000;
      const t1 = (Date.now() - this.meetingStartMs) / 1000;
      if (blob.size > 0) this.onChunk(blob, t0, t1, record.peak);
    };
    this.current = record;
    rec.start();
  }

  /** Stop recording. The final chunk is delivered through `onChunk` like any
   *  other, after this returns. */
  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.levelTimer) { clearInterval(this.levelTimer); this.levelTimer = null; }
    const closing = this.current;
    this.current = null;
    try { closing?.rec.stop(); } catch { /* noop */ }
    try { void this.audioCtx?.close(); } catch { /* noop */ }
    this.audioCtx = null;
    this.analyser = null;
    try { this.stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
  }
}

// ─── The session ─────────────────────────────────────────────────────────────
let you: ChunkRecorder | null = null;
let them: ChunkRecorder | null = null;
let tick: ReturnType<typeof setInterval> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let segSeq = 0;

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; void saveNow(); }, 800);
}

async function saveNow(): Promise<string | null> {
  const m = state.meeting;
  if (!m) return null;
  try {
    const res = await window.cth.staplerSave(m);
    if (res.ok) {
      // Only stamp the path if the meeting on screen is still this one.
      if (state.meeting?.id === m.id) setState({ markdownPath: res.markdownPath });
      return res.markdownPath;
    }
    setState({ error: res.error });
  } catch (e) {
    setState({ error: e instanceof Error ? e.message : 'could not save the meeting' });
  }
  return null;
}

function patchMeeting(id: string, fn: (m: StaplerMeeting) => StaplerMeeting): void {
  const m = state.meeting;
  if (!m || m.id !== id) return;
  setState({ meeting: fn(m) });
  scheduleSave();
}

async function transcribeChunk(meetingId: string, who: StaplerSpeaker, blob: Blob, t0: number, t1: number): Promise<void> {
  setState({ pending: state.pending + 1 });
  try {
    const buf = await blob.arrayBuffer();
    const type = blob.type || 'audio/webm';
    const ext = type.includes('ogg') ? 'ogg' : 'webm';
    const res = await window.cth.staplerTranscribe({
      audio: buf, mimeType: type.split(';')[0], filename: `${who}-${Math.round(t0)}.${ext}`
    });
    if (res.ok) {
      const text = (res.text ?? '').trim();
      if (text && !isPhantomTranscript(text)) {
        segSeq += 1;
        const seg: StaplerSegment = { id: `s-${Date.now()}-${segSeq}`, who, t0, t1, text };
        patchMeeting(meetingId, (m) => ({ ...m, segments: [...m.segments, seg] }));
      }
    } else if (res.error) {
      setState({ error: res.error });
    }
  } catch (e) {
    setState({ error: e instanceof Error ? e.message : 'transcription failed' });
  } finally {
    setState({ pending: Math.max(0, state.pending - 1) });
  }
}

/** Open the microphone. Throws a readable message. */
async function openMic(): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new Error('microphone not available');
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    throw new Error(name === 'NotAllowedError' ? 'microphone permission denied' : 'could not open microphone');
  }
}

/** Open the other side. Resolves null, never throws: a meeting without Them is
 *  still a meeting. The video track main had to include is dropped at once. */
async function openLoopback(): Promise<{ stream: MediaStream | null; failure: ThemFailure | null }> {
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) return { stream: null, failure: 'unsupported' };
    const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    s.getVideoTracks().forEach((t) => { t.stop(); s.removeTrack(t); });
    if (s.getAudioTracks().length === 0) {
      // Main answered with a screen but no loopback track: not Windows, or
      // the Stapler flag is off on the main side.
      s.getTracks().forEach((t) => t.stop());
      return { stream: null, failure: 'no-audio' };
    }
    return { stream: s, failure: null };
  } catch (e) {
    console.warn('[stapler] system audio not captured:', e);
    return { stream: null, failure: classifyThemFailure(e) };
  }
}

async function start(): Promise<void> {
  if (state.status !== 'idle') return;
  setState({ status: 'starting', error: null, elapsed: 0, pending: 0, themFailure: null });
  // System audio FIRST: getDisplayMedia needs the click that started us to be
  // recent, and the microphone has no such clock.
  const loopback = await openLoopback();
  const loop = loopback.stream;
  let mic: MediaStream;
  try {
    mic = await openMic();
  } catch (e) {
    loop?.getTracks().forEach((t) => t.stop());
    setState({ status: 'idle', error: e instanceof Error ? e.message : 'could not open microphone' });
    return;
  }
  const startedAt = new Date();
  const meeting: StaplerMeeting = {
    id: newMeetingId(startedAt),
    title: '',
    description: '',
    startedAt: startedAt.toISOString(),
    themCaptured: !!loop,
    segments: []
  };
  const startMs = startedAt.getTime();
  const id = meeting.id;
  const onChunk = (who: StaplerSpeaker) => (blob: Blob, t0: number, t1: number, peak: number) => {
    if (peak < LEVEL_FLOOR) return; // nobody spoke
    void transcribeChunk(id, who, blob, t0, t1);
  };
  try {
    you = new ChunkRecorder(mic, startMs, onChunk('you'));
    you.start();
    if (loop) {
      them = new ChunkRecorder(loop, startMs, onChunk('them'));
      them.start();
    }
  } catch {
    you?.stop(); them?.stop(); you = null; them = null;
    setState({ status: 'idle', error: 'recording not supported' });
    return;
  }
  setState({ status: 'recording', meeting, themAvailable: !!loop, themFailure: loopback.failure, markdownPath: null });
  tick = setInterval(() => setState({ elapsed: Math.floor((Date.now() - startMs) / 1000) }), 1000);
  scheduleSave();
}

function stop(): void {
  if (state.status !== 'recording') return;
  setState({ status: 'stopping' });
  if (tick) { clearInterval(tick); tick = null; }
  you?.stop(); them?.stop();
  you = null; them = null;
  const m = state.meeting;
  if (m) {
    setState({ meeting: { ...m, endedAt: new Date().toISOString(), title: m.title || defaultTitle(m.startedAt) } });
  }
  setState({ status: 'idle' });
  void saveNow();
}

function toggle(): void {
  if (state.status === 'recording') stop();
  else if (state.status === 'idle') void start();
}

function setTitle(title: string): void {
  const m = state.meeting; if (!m) return;
  patchMeeting(m.id, (x) => ({ ...x, title }));
}
function setDescription(description: string): void {
  const m = state.meeting; if (!m) return;
  patchMeeting(m.id, (x) => ({ ...x, description }));
}
function setSegmentText(segId: string, text: string): void {
  const m = state.meeting; if (!m) return;
  patchMeeting(m.id, (x) => ({ ...x, segments: x.segments.map((s) => (s.id === segId ? { ...s, text } : s)) }));
}
function removeSegment(segId: string): void {
  const m = state.meeting; if (!m) return;
  patchMeeting(m.id, (x) => ({ ...x, segments: x.segments.filter((s) => s.id !== segId) }));
}

/** Show a past meeting. Only while nothing is recording — the live meeting is
 *  the only thing on screen until it stops. */
function open(meeting: StaplerMeeting): void {
  if (state.status !== 'idle') return;
  setState({ meeting, error: null, markdownPath: null, elapsed: 0, pending: 0 });
}
function close(): void {
  if (state.status !== 'idle') return;
  setState({ meeting: null, error: null, markdownPath: null, elapsed: 0 });
}

/** Save, then queue a short message pointing the agent at the transcript. The
 *  queue delivers when the agent is next idle, like any composer message. */
async function sendToAgent(agentId: string, instruction: string): Promise<{ ok: boolean; error?: string }> {
  const m = state.meeting;
  if (!m) return { ok: false, error: 'no meeting' };
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const path = await saveNow();
  if (!path) return { ok: false, error: state.error ?? 'could not save the meeting' };
  useStore.getState().enqueueMessage(agentId, agentMessageFor(m, path, instruction));
  return { ok: true };
}

function isRecording(): boolean { return state.status === 'recording' || state.status === 'starting'; }

export const staplerSession = {
  start, stop, toggle, setTitle, setDescription, setSegmentText, removeSegment, open, close, sendToAgent,
  isRecording, saveNow, subscribe, getSnapshot
};

export function useStapler(): StaplerState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
