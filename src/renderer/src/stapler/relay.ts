import { useEffect } from 'react';
import { litFromLevel } from './LevelBars';
import { useStore } from '@/store/store';
import { staplerSession } from './session';
import type { StaplerReport } from '@shared/staplerWidget';

/**
 * The primary window's half of the floating Stapler relay.
 *
 * Reports the recorder's state and the live roster to main (which forwards
 * them to the widget) whenever either changes, answers the widget's request
 * for a fresh one, and takes the messages the widget composes into the
 * agent's queue — the same `enqueueMessage` the composer uses, so a voice note
 * or a batch of screenshots is delivered exactly like anything typed.
 */
export function useStaplerRelay(): void {
  useEffect(() => {
    const build = (): StaplerReport => {
      const st = staplerSession.getSnapshot();
      const agents = useStore.getState().agents
        .filter((a) => a.ptyId)
        .map((a) => ({ id: a.id, name: a.name, isGod: a.isGod === true }));
      // Quantized to lit bars so the meters move without a report per sample.
      const levels = { you: litFromLevel(st.levels.you), them: st.themAvailable ? litFromLevel(st.levels.them) : 0 };
      return { status: st.status, elapsed: st.elapsed, pending: st.pending, themAvailable: st.themAvailable, levels, agents };
    };
    // Coalesce: the pty parser replaces `agents` on every chunk of output, and
    // the recorder ticks once a second; one report per animation frame is
    // plenty for a window that only draws a clock and a menu.
    let scheduled = false;
    let last = '';
    const report = (): void => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const r = build();
        const key = JSON.stringify(r);
        if (key === last) return;
        last = key;
        window.cth.staplerReport(r);
      });
    };
    const unsubSession = staplerSession.subscribe(report);
    const unsubStore = useStore.subscribe(report);
    const unsubAsk = window.cth.onStaplerRequestReport(() => { last = ''; report(); });
    const unsubDeliver = window.cth.onStaplerDeliver(({ agentId, text }) => {
      if (typeof agentId !== 'string' || typeof text !== 'string' || !text.trim()) return;
      const s = useStore.getState();
      if (!s.agents.some((a) => a.id === agentId)) return;
      s.enqueueMessage(agentId, text);
      void window.cth.trackMessageSent('composer');
    });
    report();
    return () => { unsubSession(); unsubStore(); unsubAsk(); unsubDeliver(); };
  }, []);
}
