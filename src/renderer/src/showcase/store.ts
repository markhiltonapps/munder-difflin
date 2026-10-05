/**
 * Showcase — renderer state. A module singleton with a useSyncExternalStore
 * hook, like the Stapler session: the gallery, the sidebar badge and the
 * terminal link opener all read the same list.
 *
 * `openAbs` is how a terminal link lands here: any deliverable-kind file on
 * disk can be viewed, whether or not it lives under the showcase folder.
 */
import { useSyncExternalStore } from 'react';
import { showcaseKind, type ShowcaseItem, type ShowcaseKind } from '@shared/showcase';

export interface ShowcaseViewing {
  abs: string;
  name: string;
  kind: ShowcaseKind;
  /** The gallery item this is, when it is one (so seen-state can be kept). */
  rel: string | null;
}

export interface ShowcaseState {
  root: string;
  items: ShowcaseItem[];
  unseen: number;
  loaded: boolean;
  viewing: ShowcaseViewing | null;
}

let state: ShowcaseState = { root: '', items: [], unseen: 0, loaded: false, viewing: null };
const listeners = new Set<() => void>();
let off: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshing: Promise<void> | null = null;

function emit(patch: Partial<ShowcaseState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

/** Re-read the list from main. Coalesces concurrent calls. */
export function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const r = await window.cth.showcaseList?.();
      if (!r) return;
      emit({ root: r.root, items: r.items, unseen: r.items.filter((i) => i.unseen).length, loaded: true });
    } catch {
      /* main unavailable — keep what we have */
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Start listening for changes. Idempotent; the first subscriber turns it on.
 *  A slow poll backs the push for a platform where the folder watch is off. */
function start(): void {
  if (off) return;
  off = window.cth.onShowcaseChanged?.(() => { void refresh(); }) ?? (() => {});
  pollTimer = setInterval(() => { void refresh(); }, 30_000);
  void refresh();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  start();
  return () => {
    listeners.delete(cb);
    if (!listeners.size) {
      off?.(); off = null;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
  };
}

const getSnapshot = (): ShowcaseState => state;

export function useShowcase(): ShowcaseState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Open a gallery item in the viewer and record that it has been seen. */
export function openItem(item: ShowcaseItem): void {
  emit({ viewing: { abs: item.abs, name: item.name, kind: item.kind, rel: item.rel } });
  if (item.unseen) {
    void window.cth.showcaseMarkSeen?.(item.rel).then(() => refresh()).catch(() => { /* best-effort */ });
  }
  focusTab();
}

/** Open any deliverable-kind file by absolute path (a terminal link). */
export function openAbs(abs: string): void {
  const kind = showcaseKind(abs);
  if (!kind) return;
  const name = abs.split(/[\\/]/).pop() ?? abs;
  const item = state.items.find((i) => i.abs === abs);
  if (item) { openItem(item); return; }
  emit({ viewing: { abs, name, kind, rel: null } });
  focusTab();
}

export function closeViewer(): void {
  emit({ viewing: null });
}

/** Bring the Showcase tab to the front: select the orchestrator and ask the
 *  Command Center for the tab. Lazy store import keeps this module free of
 *  zustand at load, so the pure parts stay testable. */
function focusTab(): void {
  void import('@/store/store').then(({ useStore }) => {
    const s = useStore.getState();
    const god = s.agents.find((a) => a.isGod);
    if (god) s.select(god.id);
    s.requestCommandCenterTab('showcase');
  }).catch(() => { /* store unavailable */ });
}

export const showcase = { refresh, openItem, openAbs, closeViewer };
