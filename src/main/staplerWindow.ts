/**
 * The floating Stapler — two utility windows owned by the main process.
 *
 * The WIDGET: a small frameless, transparent, always-on-top window that floats
 * over every app. Closed it is a face; open it is a ring of actions
 * (screenshot, record a message, record the meeting, make invisible…). It is
 * off until the user turns it on, remembers where it was put and whether it
 * was open, and never leaves the connected displays (a monitor arriving,
 * leaving or waking moves it back on screen).
 *
 * The CROP OVERLAY: a borderless window the size of one display, shown over a
 * frozen screenshot of that display so the user can drag a region. It exists
 * only for the duration of one capture.
 *
 * "Make invisible" is `setContentProtection`: the window drops out of screen
 * shares and recordings. It is forced on while a meeting is being recorded
 * (the one time the widget is guaranteed to be over a call) and follows the
 * user's preference otherwise.
 *
 * The recorder itself lives in the PRIMARY window's renderer (stapler/session);
 * this module only relays: the primary reports state and roster in, the widget
 * sends toggle / deliver out, and main forwards each to the other side.
 */
import { BrowserWindow, desktopCapturer, screen, type IpcMain, type NativeImage } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMPTY_REPORT, WIDGET_SIZE, clampToDisplays, collapsedPosition, defaultWidgetPosition,
  expandedPosition, isUsableRegion, scaleRect, shotFilename,
  type Point, type Rect, type StaplerReport
} from '../shared/staplerWidget';

export interface StaplerWindowDeps {
  /** Durable kv (position, open, invisible). */
  persist: { getKv<T = unknown>(key: string): T | undefined; setKv(key: string, value: unknown): void };
  /** Load the renderer into a window at a hash route ('stapler' / 'stapler-crop'). */
  load: (win: BrowserWindow, hash: string) => void;
  preloadPath: string;
  /** The primary window — where the recorder and the roster live. */
  getMainWindow: () => BrowserWindow | null;
  /** Where screenshots are written (`<home>/stapler/shots`). Resolved per call
   *  because the harness home can change. */
  shotsDir: () => string;
  /** The feature switch: the widget refuses to open while it is off. */
  enabled: () => boolean;
}

const KV_POS = 'stapler.widget.position';
const KV_OPEN = 'stapler.widget.open';
const KV_INVISIBLE = 'stapler.widget.invisible';
const KV_REGION = 'stapler.lastRegion';

export interface ShotResult {
  ok: true; path: string; name: string; width: number; height: number;
  /** A small PNG data URL for the widget's thumbnail row. */
  thumb: string;
}

export class StaplerWindows {
  private widget: BrowserWindow | null = null;
  private overlay: BrowserWindow | null = null;
  private ringOpen = false;
  private report: StaplerReport = EMPTY_REPORT;
  /** The capture in flight: the frozen image and the promise the widget awaits. */
  private capture: {
    image: NativeImage; scale: number; display: Rect;
    resolve: (r: ShotResult | { ok: false; error: string }) => void;
  } | null = null;
  private shotSeq = 0;
  private shotSecond = '';

  constructor(private readonly deps: StaplerWindowDeps) {
    // A display change while the widget is up: put it back on a screen.
    const back = (): void => this.keepOnScreen();
    screen.on('display-added', back);
    screen.on('display-removed', back);
    screen.on('display-metrics-changed', back);
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────────

  isOpen(): boolean { return !!this.widget && !this.widget.isDestroyed(); }

  isInvisible(): boolean { return this.deps.persist.getKv<boolean>(KV_INVISIBLE) === true; }

  /** Bring the widget back if it was up when the app last quit. */
  restoreOnLaunch(): void {
    if (this.deps.enabled() && this.deps.persist.getKv<boolean>(KV_OPEN) === true) this.open();
  }

  open(): { ok: boolean; error?: string } {
    if (!this.deps.enabled()) return { ok: false, error: 'Stapler is disabled' };
    if (this.isOpen()) { this.widget?.show(); return { ok: true }; }
    const size = WIDGET_SIZE.closed;
    const saved = this.deps.persist.getKv<Point>(KV_POS);
    const primary = screen.getPrimaryDisplay().workArea;
    const pos = saved && typeof saved.x === 'number' && typeof saved.y === 'number'
      ? clampToDisplays({ ...saved, ...size }, screen.getAllDisplays().map((d) => d.workArea))
      : defaultWidgetPosition(primary, size);
    const win = new BrowserWindow({
      x: pos.x, y: pos.y, width: size.width, height: size.height,
      frame: false, transparent: true, hasShadow: false, resizable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false, minimizable: false, maximizable: false,
      fullscreenable: false, title: 'Stapler',
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.deps.preloadPath,
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        // The widget records a voice message and times a meeting; a throttled
        // timer would stretch both.
        backgroundThrottling: false
      }
    });
    // Over everything, including full-screen apps: that is where the call is.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.widget = win;
    this.ringOpen = false;
    this.applyProtection();
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
    win.on('moved', () => this.savePosition());
    win.on('closed', () => { if (this.widget === win) this.widget = null; this.broadcastChanged(); });
    this.deps.load(win, 'stapler');
    this.deps.persist.setKv(KV_OPEN, true);
    this.broadcastChanged();
    return { ok: true };
  }

  close(): void {
    this.deps.persist.setKv(KV_OPEN, false);
    const w = this.widget;
    this.widget = null;
    if (w && !w.isDestroyed()) w.close();
    this.broadcastChanged();
  }

  toggle(): { ok: boolean; open: boolean; error?: string } {
    if (this.isOpen()) { this.close(); return { ok: true, open: false }; }
    const r = this.open();
    return { ok: r.ok, open: r.ok, error: r.error };
  }

  destroyAll(): void {
    for (const w of [this.widget, this.overlay]) { if (w && !w.isDestroyed()) w.destroy(); }
    this.widget = null; this.overlay = null;
  }

  // ─── geometry ───────────────────────────────────────────────────────────────

  /** The widget asked to grow into the ring or shrink to the face. */
  setRingOpen(open: boolean): void {
    const w = this.widget;
    if (!w || w.isDestroyed() || open === this.ringOpen) return;
    const cur = w.getBounds();
    const wa = screen.getDisplayMatching(cur).workArea;
    const size = open ? WIDGET_SIZE.open : WIDGET_SIZE.closed;
    const pos = open ? expandedPosition(cur, size, wa) : collapsedPosition(cur, size, wa);
    this.ringOpen = open;
    w.setBounds({ x: pos.x, y: pos.y, width: size.width, height: size.height });
    this.savePosition();
  }

  resetPosition(): void {
    const w = this.widget;
    if (!w || w.isDestroyed()) return;
    const size = this.ringOpen ? WIDGET_SIZE.open : WIDGET_SIZE.closed;
    const wa = screen.getPrimaryDisplay().workArea;
    const pos = { x: Math.round(wa.x + (wa.width - size.width) / 2), y: Math.round(wa.y + (wa.height - size.height) / 2) };
    w.setBounds({ ...pos, width: size.width, height: size.height });
    this.savePosition();
  }

  private savePosition(): void {
    const w = this.widget;
    if (!w || w.isDestroyed()) return;
    const b = w.getBounds();
    // Always remember the FACE's corner so a relaunch (which opens closed)
    // lands where the user left it, whichever state it was in.
    const wa = screen.getDisplayMatching(b).workArea;
    const pos = this.ringOpen ? collapsedPosition(b, WIDGET_SIZE.closed, wa) : { x: b.x, y: b.y };
    this.deps.persist.setKv(KV_POS, pos);
  }

  private keepOnScreen(): void {
    const w = this.widget;
    if (!w || w.isDestroyed()) return;
    const b = w.getBounds();
    const pos = clampToDisplays(b, screen.getAllDisplays().map((d) => d.workArea));
    if (pos.x !== b.x || pos.y !== b.y) { w.setPosition(pos.x, pos.y); this.savePosition(); }
  }

  // ─── invisibility ───────────────────────────────────────────────────────────

  setInvisible(on: boolean): boolean {
    this.deps.persist.setKv(KV_INVISIBLE, on);
    this.applyProtection();
    this.broadcastChanged();
    return on;
  }

  /** Preference OR a meeting in progress. */
  private applyProtection(): void {
    const on = this.isInvisible() || this.report.status === 'recording' || this.report.status === 'starting';
    for (const w of [this.widget, this.overlay]) {
      if (w && !w.isDestroyed()) { try { w.setContentProtection(on); } catch { /* unsupported */ } }
    }
  }

  // ─── relay ──────────────────────────────────────────────────────────────────

  /** The primary window's recorder state and roster, forwarded to the widget. */
  reportState(report: StaplerReport): void {
    const wasRecording = this.report.status === 'recording' || this.report.status === 'starting';
    this.report = report;
    const isRecording = report.status === 'recording' || report.status === 'starting';
    if (wasRecording !== isRecording) this.applyProtection();
    this.sendToWidget('stapler:report', report);
  }

  lastReport(): StaplerReport { return this.report; }

  sendToWidget(channel: string, payload?: unknown): void {
    const w = this.widget;
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }

  sendToMain(channel: string, payload?: unknown): void {
    const m = this.deps.getMainWindow();
    if (m && !m.isDestroyed()) m.webContents.send(channel, payload);
  }

  focusMain(): void {
    const m = this.deps.getMainWindow();
    if (!m || m.isDestroyed()) return;
    if (m.isMinimized()) m.restore();
    m.show();
    m.focus();
  }

  /** Tell the primary window the widget's open / invisible state changed, so
   *  the Stapler tab's buttons read right. */
  private broadcastChanged(): void {
    this.sendToMain('stapler:widgetChanged', { open: this.isOpen(), invisible: this.isInvisible() });
  }

  isWidgetSender(sender: Electron.WebContents): boolean {
    return !!this.widget && !this.widget.isDestroyed() && this.widget.webContents === sender;
  }

  // ─── screenshots ────────────────────────────────────────────────────────────

  /** Freeze the display the widget sits on, let the user drag a region over
   *  it, write the crop as PNG. Resolves when the overlay closes. */
  async screenshot(): Promise<ShotResult | { ok: false; error: string }> {
    if (this.capture) return { ok: false, error: 'a capture is already open' };
    const w = this.widget;
    const anchor = w && !w.isDestroyed() ? w.getBounds() : screen.getPrimaryDisplay().bounds;
    const display = screen.getDisplayMatching(anchor);
    const scale = display.scaleFactor || 1;
    // Hide the widget so it is not in its own picture; the overlay replaces it.
    if (w && !w.isDestroyed()) w.hide();
    await new Promise((r) => setTimeout(r, 180));
    let image: NativeImage | null = null;
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }
      });
      const match = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      image = match?.thumbnail ?? null;
    } catch (e) {
      if (w && !w.isDestroyed()) w.show();
      return { ok: false, error: e instanceof Error ? e.message : 'screen capture failed' };
    }
    if (!image || image.isEmpty()) {
      if (w && !w.isDestroyed()) w.show();
      return { ok: false, error: 'screen capture failed — check the screen recording permission' };
    }
    return new Promise((resolve) => {
      this.capture = { image: image as NativeImage, scale, display: display.bounds, resolve };
      const overlay = new BrowserWindow({
        x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
        frame: false, transparent: true, hasShadow: false, resizable: false, movable: false,
        skipTaskbar: true, alwaysOnTop: true, show: false, enableLargerThanScreen: true,
        fullscreenable: false, title: 'Stapler — capture',
        backgroundColor: '#00000000',
        webPreferences: { preload: this.deps.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false }
      });
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      // The overlay is a picture of the screen; it must not appear in a share
      // any more than the widget does.
      try { overlay.setContentProtection(true); } catch { /* unsupported */ }
      this.overlay = overlay;
      overlay.once('ready-to-show', () => { if (!overlay.isDestroyed()) { overlay.show(); overlay.focus(); } });
      overlay.on('closed', () => {
        if (this.overlay === overlay) this.overlay = null;
        // Closed without an answer (Alt+F4, a crash): cancel.
        this.finishCapture(null);
      });
      this.deps.load(overlay, 'stapler-crop');
    });
  }

  /** What the overlay draws: the frozen screen and the last region used. */
  cropImage(): { dataUrl: string; width: number; height: number; lastRegion: Rect | null } | null {
    const c = this.capture;
    if (!c) return null;
    const last = this.deps.persist.getKv<Rect>(KV_REGION);
    return {
      dataUrl: c.image.toDataURL(),
      width: c.display.width, height: c.display.height,
      lastRegion: isUsableRegion(last) ? last : null
    };
  }

  /** The overlay's answer: a region in CSS pixels of that display, or null. */
  finishCapture(region: Rect | null): void {
    const c = this.capture;
    if (!c) return;
    this.capture = null;
    const overlay = this.overlay;
    this.overlay = null;
    if (overlay && !overlay.isDestroyed()) overlay.close();
    const w = this.widget;
    if (w && !w.isDestroyed()) w.show();
    if (!isUsableRegion(region)) { c.resolve({ ok: false, error: 'cancelled' }); return; }
    try {
      const size = c.image.getSize();
      const px = scaleRect(region, c.scale, size);
      if (!isUsableRegion(px)) { c.resolve({ ok: false, error: 'region too small' }); return; }
      const crop = c.image.crop(px);
      const dir = this.deps.shotsDir();
      mkdirSync(dir, { recursive: true });
      const now = new Date();
      const second = now.toISOString().slice(0, 19);
      this.shotSeq = second === this.shotSecond ? this.shotSeq + 1 : 0;
      this.shotSecond = second;
      const name = shotFilename(now, this.shotSeq);
      const path = join(dir, name);
      writeFileSync(path, crop.toPNG());
      this.deps.persist.setKv(KV_REGION, region);
      const thumb = crop.resize({ width: Math.min(160, px.width) }).toDataURL();
      c.resolve({ ok: true, path, name, width: px.width, height: px.height, thumb });
    } catch (e) {
      c.resolve({ ok: false, error: e instanceof Error ? e.message : 'could not save the screenshot' });
    }
  }
}

/** The IPC surface for both windows, kept beside the class so index.ts stays
 *  one registration line. Channel names mirror preload. */
export function registerStaplerWindowIpc(ipc: IpcMain, sw: StaplerWindows): void {
  ipc.handle('stapler:widget:toggle', () => sw.toggle());
  ipc.handle('stapler:widget:state', () => ({ open: sw.isOpen(), invisible: sw.isInvisible() }));
  ipc.handle('stapler:widget:setInvisible', (_e, on: unknown) => ({ invisible: sw.setInvisible(on === true) }));
  ipc.on('stapler:widget:hide', () => sw.close());
  ipc.on('stapler:widget:reset', () => sw.resetPosition());
  ipc.on('stapler:widget:ring', (_e, open: unknown) => sw.setRingOpen(open === true));
  ipc.on('stapler:widget:focusMain', () => sw.focusMain());
  // Widget → primary: the meeting toggle rides the same channel as the global
  // chord, so App's one listener handles both.
  ipc.on('stapler:widget:toggleMeeting', () => sw.sendToMain('stapler:toggle'));
  ipc.on('stapler:widget:deliver', (_e, arg: unknown) => {
    const a = (arg ?? {}) as { agentId?: unknown; text?: unknown };
    if (typeof a.agentId !== 'string' || typeof a.text !== 'string' || !a.text.trim()) return;
    sw.sendToMain('stapler:deliver', { agentId: a.agentId, text: a.text.slice(0, 20_000) });
  });
  ipc.on('stapler:widget:requestReport', (e) => {
    // Answer from the cache at once, then ask the primary for a fresh one.
    e.sender.send('stapler:report', sw.lastReport());
    sw.sendToMain('stapler:requestReport');
  });
  // Primary → widget.
  ipc.on('stapler:report', (e, report: unknown) => {
    const r = report as StaplerReport;
    if (!r || typeof r !== 'object' || typeof r.status !== 'string') return;
    // Only a window that is NOT the widget may report (the widget consumes).
    if (sw.isWidgetSender(e.sender)) return;
    sw.reportState({
      status: r.status, elapsed: Number(r.elapsed) || 0, pending: Number(r.pending) || 0,
      themAvailable: typeof r.themAvailable === 'boolean' ? r.themAvailable : null,
      agents: Array.isArray(r.agents)
        ? r.agents.filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string')
            .map((a) => ({ id: a.id, name: a.name, isGod: a.isGod === true }))
        : []
    });
  });
  // Screenshots.
  ipc.handle('stapler:screenshot', () => sw.screenshot());
  ipc.handle('stapler:crop:image', () => sw.cropImage());
  ipc.on('stapler:crop:done', (_e, region: unknown) => {
    const r = region as Rect | null;
    sw.finishCapture(r && typeof r === 'object' && typeof r.x === 'number' ? r : null);
  });
}
