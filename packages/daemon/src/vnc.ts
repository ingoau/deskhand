/**
 * GET /vnc?mode=view|control&generation=N — websocket carrying raw RFB, proxied to x11vnc on
 * 127.0.0.1:5900. Client input (keys, pointer, clipboard, …) is dropped unless mode=control AND
 * the desktop is locked AND the connection's generation is current (design.md). When the
 * generation changes, control connections from an older generation are closed.
 */
import type { IncomingMessage } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Control } from "./control.js";
import { log } from "./log.js";
import { RfbClientFilter } from "./rfb.js";

export const VNC_PORT = Number(process.env.DESKHAND_VNC_PORT ?? 5900);

interface Conn {
  ws: WebSocket;
  mode: "view" | "control";
  generation: number;
}

export class VncProxy {
  private readonly wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 64 * 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });
  private readonly conns = new Set<Conn>();

  constructor(private readonly control: Control) {
    control.on("change", () => this.onControlChange());
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  private onControlChange(): void {
    for (const c of this.conns) {
      if (c.mode === "control" && c.generation !== this.control.generation) {
        log.info("closing vnc control connection from old generation", { generation: c.generation, now: this.control.generation });
        c.ws.close(4001, "control changed");
      }
    }
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, params: URLSearchParams): void {
    const mode = params.get("mode") === "control" ? "control" : "view";
    const genParam = params.get("generation");
    const generation = genParam !== null && /^\d+$/.test(genParam) ? Number(genParam) : this.control.generation;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, mode, generation));
  }

  private attach(ws: WebSocket, mode: "view" | "control", generation: number): void {
    const conn: Conn = { ws, mode, generation };
    this.conns.add(conn);
    const allowed = () => conn.mode === "control" && this.control.lock !== null && conn.generation === this.control.generation;
    const filter = new RfbClientFilter(allowed);
    const upstream = net.connect(VNC_PORT, "127.0.0.1");
    upstream.setNoDelay(true);
    log.info("vnc connected", { mode, generation });

    const close = (why: string) => {
      if (!this.conns.has(conn)) return;
      this.conns.delete(conn);
      upstream.destroy();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, why.slice(0, 120));
      log.info("vnc closed", { mode, generation, why, droppedInput: filter.dropped });
    };

    // Client data that arrives before the upstream socket connects is buffered by net.Socket.
    upstream.on("data", (b: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(b, { binary: true });
      // Simple backpressure: pause reading from x11vnc while the browser is behind.
      if (ws.bufferedAmount > 8 * 1024 * 1024) {
        upstream.pause();
        const resume = setInterval(() => {
          if (ws.readyState !== ws.OPEN || ws.bufferedAmount < 1024 * 1024) {
            clearInterval(resume);
            upstream.resume();
          }
        }, 20);
      }
    });
    upstream.on("error", (e) => close(`upstream error: ${e.message}`));
    upstream.on("close", () => close("upstream closed"));
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!isBinary && buf.length === 0) return;
      const r = filter.push(buf);
      for (const f of r.forward) upstream.write(f);
      if (r.error) {
        log.warn("vnc stream rejected", { error: r.error });
        close(`protocol error: ${r.error}`);
      }
    });
    ws.on("close", () => close("client closed"));
    ws.on("error", (e) => close(`client error: ${e.message}`));
  }

  closeAll(): void {
    for (const c of this.conns) c.ws.close(1001, "daemon shutting down");
  }
}
