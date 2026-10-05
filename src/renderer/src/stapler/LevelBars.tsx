/**
 * Five-bar level meter, shared by the Stapler tab and the floating window.
 * Takes a count of lit bars (0..5) so the widget can draw straight from the
 * quantized level in its report; `litFromLevel` turns a raw 0..1 level into
 * that count with a square-root curve, so quiet speech still shows.
 */
import { litFromLevel } from '@shared/staplerWidget';
export { litFromLevel };

export function LevelBars({ lit, label, title }: { lit: number; label?: string; title?: string }) {
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label && <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 7, lineHeight: '10px' }}>{label}</span>}
      <span aria-hidden style={{ display: 'inline-flex', gap: 2, alignItems: 'flex-end', height: 12 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} style={{ width: 3, height: 4 + i * 2, background: i < lit ? (i >= 4 ? 'var(--cth-coral)' : 'var(--cth-mint)') : 'var(--cth-ink-300)' }} />
        ))}
      </span>
    </span>
  );
}
