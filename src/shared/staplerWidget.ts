/**
 * The floating Stapler — shapes and pure geometry shared by main (which owns
 * the windows) and the widget renderer (which draws them). No Electron, no DOM.
 */

export interface Rect { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

/** Window sizes, in CSS pixels. Closed is the face alone; open is the ring. */
export const WIDGET_SIZE = {
  closed: { width: 92, height: 108 },
  open: { width: 320, height: 460 }
} as const;

/** Gap kept between the widget and the edge of the work area. */
export const WIDGET_MARGIN = 24;

/** Screenshots per send, and the voice-message cap. */
export const MAX_SHOTS = 8;
export const MAX_MESSAGE_MS = 5 * 60 * 1000;

/** What the main window tells the widget about the recorder and the roster. */
export interface StaplerReport {
  status: 'idle' | 'starting' | 'recording' | 'stopping';
  elapsed: number;
  pending: number;
  themAvailable: boolean | null;
  /** Live agents only — the ones a message can be queued to. */
  agents: Array<{ id: string; name: string; isGod?: boolean }>;
}

export const EMPTY_REPORT: StaplerReport = { status: 'idle', elapsed: 0, pending: 0, themAvailable: null, agents: [] };

/** Two corners of a drag → a normalised rectangle. */
export function normalizeDrag(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Scale a CSS-pixel rect to device pixels (rounded) and clip it to an image. */
export function scaleRect(r: Rect, factor: number, bounds: { width: number; height: number }): Rect {
  const x = Math.max(0, Math.round(r.x * factor));
  const y = Math.max(0, Math.round(r.y * factor));
  const width = Math.min(bounds.width - x, Math.round(r.width * factor));
  const height = Math.min(bounds.height - y, Math.round(r.height * factor));
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) };
}

/** A region is usable when it is at least a few pixels each way. */
export function isUsableRegion(r: Rect | null | undefined, min = 4): r is Rect {
  return !!r && r.width >= min && r.height >= min;
}

/** Keep a rect inside the display it mostly sits on; if it sits on none,
 *  put it in the default corner of the first (primary) display. */
export function clampToDisplays(rect: Rect, workAreas: Rect[]): Point {
  if (workAreas.length === 0) return { x: rect.x, y: rect.y };
  const overlap = (wa: Rect): number => {
    const w = Math.min(rect.x + rect.width, wa.x + wa.width) - Math.max(rect.x, wa.x);
    const h = Math.min(rect.y + rect.height, wa.y + wa.height) - Math.max(rect.y, wa.y);
    return w > 0 && h > 0 ? w * h : 0;
  };
  let best = workAreas[0], bestArea = 0;
  for (const wa of workAreas) {
    const a = overlap(wa);
    if (a > bestArea) { best = wa; bestArea = a; }
  }
  if (bestArea === 0) return defaultWidgetPosition(workAreas[0], rect);
  return {
    x: Math.min(Math.max(rect.x, best.x), best.x + best.width - rect.width),
    y: Math.min(Math.max(rect.y, best.y), best.y + best.height - rect.height)
  };
}

/** Bottom-right of the work area, a margin in: out of the way of the dock
 *  and the menu bar, where a floating thing is expected to live. */
export function defaultWidgetPosition(workArea: Rect, size: { width: number; height: number }): Point {
  return {
    x: workArea.x + workArea.width - size.width - WIDGET_MARGIN,
    y: workArea.y + workArea.height - size.height - WIDGET_MARGIN
  };
}

/** Where the open ring goes when the face expands: the ring keeps the face's
 *  corner that is nearest the edge of the work area, so it grows toward the
 *  middle of the screen rather than off it. */
export function expandedPosition(closed: Rect, open: { width: number; height: number }, workArea: Rect): Point {
  const faceCx = closed.x + closed.width / 2;
  const faceCy = closed.y + closed.height / 2;
  const rightHalf = faceCx > workArea.x + workArea.width / 2;
  const bottomHalf = faceCy > workArea.y + workArea.height / 2;
  const x = rightHalf ? closed.x + closed.width - open.width : closed.x;
  const y = bottomHalf ? closed.y + closed.height - open.height : closed.y;
  return clampToDisplays({ x, y, width: open.width, height: open.height }, [workArea]);
}

/** And back: the face lands on the same corner it grew from. */
export function collapsedPosition(open: Rect, closed: { width: number; height: number }, workArea: Rect): Point {
  const cx = open.x + open.width / 2;
  const cy = open.y + open.height / 2;
  const rightHalf = cx > workArea.x + workArea.width / 2;
  const bottomHalf = cy > workArea.y + workArea.height / 2;
  const x = rightHalf ? open.x + open.width - closed.width : open.x;
  const y = bottomHalf ? open.y + open.height - closed.height : open.y;
  return clampToDisplays({ x, y, width: closed.width, height: closed.height }, [workArea]);
}

/** The message a batch of screenshots becomes: the note, then the same
 *  "Attached files:" block the queue composer writes, so an agent Reads the
 *  pictures the way it Reads any attachment. */
export function shotsMessage(note: string, shots: Array<{ path: string; name: string }>): string {
  const head = note.trim();
  const list = shots.map((s) => `- ${s.path} (${s.name})`).join('\n');
  if (shots.length === 0) return head;
  return (head ? `${head}\n\nAttached files:\n` : 'Attached files:\n') + list;
}

/** A screenshot's filename: sortable, no spaces, unique to the second plus a
 *  counter for bursts inside one second. */
export function shotFilename(now: Date, seq: number): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `shot-${stamp}${seq > 0 ? `-${seq}` : ''}.png`;
}
