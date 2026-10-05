/**
 * Slack Socket Mode — the app opens a WebSocket OUT to Slack and events come
 * down it. No public URL, no tunnel, nothing to re-paste after a restart, and
 * it works behind any router: the connection is ours, so when it drops we
 * open another.
 *
 * Protocol (api.slack.com/apis/socket-mode):
 *   1. POST apps.connections.open with the APP-LEVEL token (xapp-…, scope
 *      connections:write) → a one-shot wss:// URL.
 *   2. Connect. Slack sends `hello`, then envelopes: `events_api` (the same
 *      event_callback payload the Events API posts), `slash_commands`,
 *      `interactive`. Every envelope must be acknowledged within three seconds
 *      by sending back `{ envelope_id }`, or Slack redelivers it.
 *   3. `disconnect` means Slack is retiring this link (refresh_requested,
 *      warning, link_disabled): close and open a new one. A dropped socket is
 *      the same thing from our side.
 *
 * Reconnects back off from one second to thirty and reset on `hello`. The
 * router (shared with the HTTP transport) decides what each event means.
 */
import { request as httpsRequest } from 'node:https';
import WebSocket from 'ws';
import type { SlackEventRouter, SlackPayload } from './slack';

export interface SocketFrame {
  type?: string;
  envelope_id?: string;
  payload?: unknown;
  reason?: string;
  accepts_response_payload?: boolean;
}

/** What one inbound frame calls for. Pure, so the protocol is testable without
 *  a socket: the client acts on the plan, the tests assert it. */
export function planFrame(frame: SocketFrame): { ack?: string; event?: SlackPayload; reconnect?: boolean; hello?: boolean } {
  const out: { ack?: string; event?: SlackPayload; reconnect?: boolean; hello?: boolean } = {};
  if (!frame || typeof frame !== 'object') return out;
  if (frame.type === 'hello') { out.hello = true; return out; }
  if (frame.type === 'disconnect') { out.reconnect = true; return out; }
  // Anything with an envelope is acknowledged, whatever it is — an un-acked
  // envelope is redelivered, and a kind we do not handle is still ours.
  if (typeof frame.envelope_id === 'string' && frame.envelope_id) out.ack = frame.envelope_id;
  if (frame.type === 'events_api' && frame.payload && typeof frame.payload === 'object') {
    out.event = frame.payload as SlackPayload;
  }
  return out;
}

export interface SlackSocketStatus {
  connected: boolean;
  /** ISO time of the current connection's hello, when connected. */
  since?: string;
  /** Last failure, kept until the next hello. */
  error?: string;
  /** Reconnects attempted since the last hello. */
  attempts: number;
}

const SLACK_API_TIMEOUT_MS = 12_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** Ask Slack for a Socket Mode URL. The app-level token is used only for the
 *  Authorization header and never logged. */
export function openConnection(appToken: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const req = httpsRequest({
      method: 'POST', host: 'slack.com', path: '/api/apps.connections.open',
      headers: { Authorization: `Bearer ${appToken}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': 0 },
      timeout: SLACK_API_TIMEOUT_MS
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok?: boolean; url?: string; error?: string };
          if (body.ok && typeof body.url === 'string') resolve({ ok: true, url: body.url });
          else resolve({ ok: false, error: `Slack: ${body.error ?? `HTTP ${res.statusCode}`}` });
        } catch {
          resolve({ ok: false, error: `Slack: unreadable reply (HTTP ${res.statusCode})` });
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

export interface SlackSocketClientOptions {
  appToken: string;
  router: SlackEventRouter;
  /** Called on every status change — connected, dropped, erroring. */
  onStatus?: (s: SlackSocketStatus) => void;
}

export class SlackSocketClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private current: SlackSocketStatus = { connected: false, attempts: 0 };

  constructor(private readonly opts: SlackSocketClientOptions) {}

  status(): SlackSocketStatus { return this.current; }

  /** Open the first link. Resolves ok once Slack handed out a URL (the token
   *  is good); the socket itself connects right after and reports through
   *  onStatus. A bad token resolves ok:false and nothing is retried. */
  async start(): Promise<{ ok: boolean; error?: string }> {
    this.stopped = false;
    const opened = await openConnection(this.opts.appToken);
    if (!opened.ok) { this.setStatus({ connected: false, error: opened.error, attempts: 0 }); return opened; }
    this.connect(opened.url);
    return { ok: true };
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* noop */ }
    this.setStatus({ connected: false, attempts: 0 });
  }

  private setStatus(s: SlackSocketStatus): void {
    this.current = s;
    try { this.opts.onStatus?.(s); } catch { /* observer's problem */ }
  }

  private connect(url: string): void {
    if (this.stopped) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('message', (data) => {
      let frame: SocketFrame;
      try { frame = JSON.parse(data.toString()) as SocketFrame; } catch { return; }
      const plan = planFrame(frame);
      // Ack FIRST — Slack's three-second clock is running — then route.
      if (plan.ack) { try { ws.send(JSON.stringify({ envelope_id: plan.ack })); } catch { /* socket gone; it will redeliver */ } }
      if (plan.hello) {
        this.attempts = 0;
        this.setStatus({ connected: true, since: new Date().toISOString(), attempts: 0 });
      }
      if (plan.event) this.opts.router.handleEventCallback(plan.event);
      if (plan.reconnect) { try { ws.close(); } catch { /* noop */ } }
    });
    ws.on('close', () => { if (this.ws === ws) { this.ws = null; this.scheduleReconnect(undefined); } });
    ws.on('error', (e) => { if (this.ws === ws) { this.ws = null; try { ws.close(); } catch { /* noop */ } this.scheduleReconnect(e.message); } });
  }

  private scheduleReconnect(error: string | undefined): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempts += 1;
    this.setStatus({ connected: false, error: error ?? this.current.error, attempts: this.attempts });
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(5, this.attempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void openConnection(this.opts.appToken).then((opened) => {
        if (this.stopped) return;
        if (!opened.ok) { this.scheduleReconnect(opened.error); return; }
        this.connect(opened.url);
      });
    }, delay);
  }
}
