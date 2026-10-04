import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeDrag, isUsableRegion, type Point, type Rect } from '@shared/staplerWidget';

/**
 * The crop overlay: a frozen picture of one display with a region to drag.
 *
 * Main opened this window the size of the display and hands over the image;
 * everything here is in that display's CSS pixels, which is what main scales
 * back to device pixels for the crop. The last region used is offered first,
 * so a repeat shot of the same window is Enter and done.
 *
 * Esc cancels, Enter or a double-click accepts, and a drag draws a new region.
 */
export function StaplerCrop() {
  const { t } = useTranslation();
  const [img, setImg] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [region, setRegion] = useState<Rect | null>(null);
  const dragStart = useRef<Point | null>(null);
  const [dragging, setDragging] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    // Transparent window: the image IS the background.
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.backgroundImage = 'none';
    document.getElementById('root')?.style.setProperty('background', 'transparent');
    document.getElementById('cth-splash')?.remove();
    document.body.style.cursor = 'crosshair';
  }, []);

  useEffect(() => {
    let alive = true;
    window.cth.staplerCropImage().then((r) => {
      if (!alive) return;
      if (!r) { finish(null); return; }
      setImg({ dataUrl: r.dataUrl, width: r.width, height: r.height });
      if (r.lastRegion) setRegion(r.lastRegion);
    }).catch(() => finish(null));
    return () => { alive = false; };
  }, []);

  const finish = (r: Rect | null): void => {
    if (done.current) return;
    done.current = true;
    window.cth.staplerCropDone(r);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      if (e.key === 'Enter') { e.preventDefault(); if (isUsableRegion(region)) finish(region); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [region]);

  const onDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return;
    dragStart.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
    setRegion({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
  };
  const onMove = (e: React.MouseEvent): void => {
    if (!dragging || !dragStart.current) return;
    setRegion(normalizeDrag(dragStart.current, { x: e.clientX, y: e.clientY }));
  };
  const onUp = (e: React.MouseEvent): void => {
    if (!dragging || !dragStart.current) return;
    setDragging(false);
    const r = normalizeDrag(dragStart.current, { x: e.clientX, y: e.clientY });
    dragStart.current = null;
    // A click without a drag keeps whatever region was there (the last one).
    if (isUsableRegion(r)) setRegion(r);
    else if (!isUsableRegion(region)) setRegion(null);
  };

  const r = region;
  return (
    <div
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onDoubleClick={() => { if (isUsableRegion(r)) finish(r); }}
      style={{ position: 'fixed', inset: 0, overflow: 'hidden', userSelect: 'none', fontFamily: 'var(--cth-font-ui)' }}
    >
      {img && (
        <img
          src={img.dataUrl}
          alt=""
          draggable={false}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
        />
      )}
      {/* Dim everything except the region. Four rectangles rather than a
          clip-path so the selection edge stays crisp at any size. */}
      {(() => {
        const dim = 'rgba(26,19,32,0.45)';
        if (!isUsableRegion(r)) return <div style={{ position: 'absolute', inset: 0, background: dim }} />;
        return (
          <>
            <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: r.y, background: dim }} />
            <div style={{ position: 'absolute', left: 0, top: r.y + r.height, right: 0, bottom: 0, background: dim }} />
            <div style={{ position: 'absolute', left: 0, top: r.y, width: r.x, height: r.height, background: dim }} />
            <div style={{ position: 'absolute', left: r.x + r.width, top: r.y, right: 0, height: r.height, background: dim }} />
            <div style={{
              position: 'absolute', left: r.x, top: r.y, width: r.width, height: r.height,
              boxShadow: '0 0 0 2px var(--cth-lemon), 0 0 0 3px rgba(26,19,32,0.6)', pointerEvents: 'none'
            }} />
            <div style={{
              position: 'absolute', left: r.x, top: Math.max(4, r.y - 22),
              padding: '2px 6px', background: 'var(--cth-ink-900)', color: 'var(--cth-cream-100)',
              fontFamily: 'var(--cth-font-mono)', fontSize: 11, lineHeight: '16px', pointerEvents: 'none'
            }}>{Math.round(r.width)} × {Math.round(r.height)}</div>
          </>
        );
      })()}
      <div style={{
        position: 'absolute', left: '50%', top: 16, transform: 'translateX(-50%)',
        padding: '6px 12px', background: 'var(--cth-cream-100)', color: 'var(--cth-ink-900)',
        boxShadow: '0 0 0 2px var(--cth-ink-900), 3px 4px 0 rgba(26,19,32,0.22)',
        fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap', pointerEvents: 'none'
      }}>
        {isUsableRegion(r) ? t('staplerWidget.cropHintRegion') : t('staplerWidget.cropHint')}
      </div>
    </div>
  );
}
