import type { ClientMessage, ServerMessage } from "./roomTypes";

type MessageHandler = (msg: ServerMessage) => void;
type StatusHandler = (connected: boolean) => void;

export class RoomWebSocket {
  private ws: WebSocket | null = null;
  private onMessageHandler: MessageHandler | null = null;
  private onStatusHandler: StatusHandler | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url = "";
  private joinPayload: ClientMessage | null = null;

  onMessage(handler: MessageHandler): void {
    this.onMessageHandler = handler;
  }

  onStatus(handler: StatusHandler): void {
    this.onStatusHandler = handler;
  }

  connect(serverUrl: string, roomId: string, userName: string): void {
    this.disconnect();
    this.reconnectAttempts = 0;

    const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
    this.url = wsUrl;
    this.joinPayload = { type: "join_room", roomId, userName };

    this.doConnect();
  }

  private doConnect(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.onStatusHandler?.(false);
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.onStatusHandler?.(true);
      if (this.joinPayload) {
        this.send(this.joinPayload);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        this.onMessageHandler?.(msg);
      } catch {}
    };

    this.ws.onclose = () => {
      this.onStatusHandler?.(false);
      this.tryReconnect();
    };

    this.ws.onerror = () => {};
  }

  private tryReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 8000);
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.maxReconnectAttempts = 0; // Prevent reconnect on intentional close
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.maxReconnectAttempts = 3; // Restore for future connections
    this.joinPayload = null;
    this.onStatusHandler?.(false);
  }
}
