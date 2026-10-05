/**
 * Realtime Michael — spoken tool fillers.
 *
 * A tool call is a few seconds of silence from the model's side: it has
 * emitted a function call and now waits for the result before it can speak
 * again. The persona asks the model to say "let me check" first, but the
 * model does not always oblige. This module makes the gap audible either way:
 * the instant a tool starts, if the model has not spoken yet in this turn, a
 * short clip in Michael's voice plays ("one sec, let me check"), and the tool
 * result is held back until the clip has finished so the two never overlap.
 *
 * Clips are text-to-speech generated ONCE per machine by main
 * (realtime:fillerClip, cached on disk) and prefetched in the background right
 * after a session connects. No clip, no key, no network → the tool runs as
 * before, in silence.
 */
import type { FunctionTool } from '@openai/agents-realtime';
import { TOOL_FILLERS, pickFiller } from './turnTaking';

const clips = new Map<string, string>();
let prefetching: Promise<void> | null = null;
/** Longest a filler may hold a tool result: a clip is ~1–2 s, this is the fuse. */
const FILLER_MAX_MS = 4_000;

/** Fetch every filler clip (idempotent, best-effort, never throws). */
export function prefetchFillers(): Promise<void> {
  if (prefetching) return prefetching;
  prefetching = (async () => {
    for (const text of TOOL_FILLERS) {
      if (clips.has(text)) continue;
      try {
        const r = await window.cth.realtimeFillerClip?.(text);
        if (r?.ok) clips.set(text, r.dataUrl);
      } catch { /* best-effort — the tool just runs silently */ }
    }
  })().finally(() => { prefetching = null; });
  return prefetching;
}

/** Test/diagnostic hook: how many clips are ready. */
export function fillersReady(): number { return clips.size; }

/** Play one cached filler on `sinkId` (null = system default). Resolves when the
 *  clip ends, errors out, or the fuse blows — never rejects. Resolves at once
 *  when nothing is cached yet. */
export function playFiller(sinkId: string | null, rand: () => number = Math.random): Promise<void> {
  const ready = TOOL_FILLERS.filter((t) => clips.has(t));
  if (!ready.length) return Promise.resolve();
  const text = pickFiller(rand);
  const src = clips.get(text) ?? clips.get(ready[0]) ?? '';
  if (!src) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => { if (!done) { done = true; clearTimeout(fuse); resolve(); } };
    const fuse = setTimeout(finish, FILLER_MAX_MS);
    try {
      const el = new Audio(src);
      el.onended = finish;
      el.onerror = finish;
      const sink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      const route = typeof sink.setSinkId === 'function' ? sink.setSinkId(sinkId ?? '').catch(() => undefined) : Promise.resolve();
      void route.then(() => el.play()).catch(finish);
    } catch {
      finish();
    }
  });
}

export interface FillerPolicy {
  /** Whether a clip should play for THIS call — false when the model already
   *  spoke in the current turn (it said its own filler) or the feature is off. */
  shouldPlay: () => boolean;
  /** Output device for the clip. */
  sinkId: () => string | null;
}

/** Wrap tools so a filler plays when they start and the result waits for it.
 *  The wrapper is transparent to the model: same name, schema and output. */
export function withSpokenFiller<T extends FunctionTool<any, any, any>>(tools: T[], policy: FillerPolicy): T[] {
  return tools.map((t) => {
    const invoke: T['invoke'] = async (runContext, input, details) => {
      const clip = policy.shouldPlay() ? playFiller(policy.sinkId()) : Promise.resolve();
      const [result] = await Promise.all([t.invoke(runContext, input, details), clip]);
      return result;
    };
    return { ...t, invoke };
  });
}
