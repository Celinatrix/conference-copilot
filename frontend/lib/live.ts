import type { ClientMessage, ServerEvent } from '@conference-copilot/shared';
import { api } from './api';

/** Every event the live socket can deliver (shared contract with the backend). */
export type LiveEvent = ServerEvent;

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** 100 ms chunks → 2 minutes of audio kept while the network is down. */
const MAX_BUFFERED_CHUNKS = 1200;

function wsBase() {
  const configured = process.env.NEXT_PUBLIC_WS_URL;
  if (configured) return configured;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.hostname}:4000`;
}

/**
 * One socket per open conference page. Reconnects with backoff; while disconnected, outgoing audio
 * is queued and replayed after the host re-claims its session, so short network drops lose no speech.
 */
export class LiveSocket {
  private ws: WebSocket | null = null;
  private queue: ArrayBuffer[] = [];
  private attempt = 0;
  private closedByUser = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while this tab is the recording host, so a reconnect re-claims the session before replaying audio. */
  wantsHost = false;
  droppedChunks = 0;

  constructor(
    private conferenceId: string,
    private onEvent: (e: LiveEvent) => void,
    private onConnection: (s: ConnectionState, detail?: string) => void,
  ) {}

  async connect() {
    this.closedByUser = false;
    this.onConnection(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ticket: string;
    try {
      ({ ticket } = await api<{ ticket: string }>(`/api/conferences/${this.conferenceId}/ws-ticket`, { method: 'POST' }));
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : undefined);
      return;
    }
    if (this.closedByUser) return;
    const ws = new WebSocket(`${wsBase()}/ws?ticket=${encodeURIComponent(ticket)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.onConnection('open');
      if (this.wantsHost) ws.send(JSON.stringify({ type: 'reclaim' }));
      for (const chunk of this.queue) ws.send(chunk);
      this.queue = [];
    };
    ws.onmessage = (msg) => {
      if (typeof msg.data !== 'string') return;
      try {
        this.onEvent(JSON.parse(msg.data) as LiveEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUser) return this.onConnection('closed');
      if (e.code === 4401 || e.code === 4403) {
        // Ticket expired or access revoked: fetch a fresh ticket (access is re-checked server side).
        this.scheduleReconnect(e.code === 4403 ? 'Không có quyền truy cập hội nghị này.' : undefined);
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(detail?: string) {
    if (this.closedByUser) return;
    this.attempt++;
    this.onConnection('reconnecting', detail);
    const delay = Math.min(500 * 2 ** Math.min(this.attempt - 1, 4), 8000) + Math.random() * 300;
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get queuedChunks() {
    return this.queue.length;
  }

  send(msg: ClientMessage) {
    if (this.isOpen) this.ws!.send(JSON.stringify(msg));
  }

  sendAudio(chunk: ArrayBuffer) {
    if (this.isOpen && this.queue.length === 0) {
      this.ws!.send(chunk);
      return;
    }
    this.queue.push(chunk);
    if (this.queue.length > MAX_BUFFERED_CHUNKS) {
      this.queue.shift();
      this.droppedChunks++;
    }
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
