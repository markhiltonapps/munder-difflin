/** The voices gpt-realtime speaks with. Marin and cedar are the two newest and
 *  most natural; the rest are the classic set. One list for Settings, the
 *  session and the voice policy, so they cannot disagree. */
export const REALTIME_VOICES = ['cedar', 'marin', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] as const;
export type RealtimeVoice = (typeof REALTIME_VOICES)[number];
export const DEFAULT_REALTIME_VOICE: RealtimeVoice = 'cedar';
export function normalizeVoice(v: unknown): RealtimeVoice {
  return (REALTIME_VOICES as readonly string[]).includes(v as string) ? (v as RealtimeVoice) : DEFAULT_REALTIME_VOICE;
}
