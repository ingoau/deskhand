/**
 * RFB (VNC) client→server stream filter for the /vnc proxy. Parses the client side of the
 * handshake and every client message so input (KeyEvent, PointerEvent, ClientCutText, QEMU key
 * events, GII) can be dropped unless input is allowed, without breaking message framing.
 * Unknown messages cannot be framed, so they end the connection.
 *
 * Supported: RFB 3.7 / 3.8 with security None (1) or VNC auth (2) — what x11vnc offers.
 */

export type RfbMessageKind =
  | "SetPixelFormat"
  | "SetEncodings"
  | "FramebufferUpdateRequest"
  | "KeyEvent"
  | "PointerEvent"
  | "ClientCutText"
  | "EnableContinuousUpdates"
  | "ClientFence"
  | "SetDesktopSize"
  | "Xvp"
  | "QemuExtendedKeyEvent"
  | "QemuAudio"
  | "Gii";

/** Messages that change the desktop: forwarded only when input is allowed. */
const INPUT_KINDS = new Set<RfbMessageKind>(["KeyEvent", "PointerEvent", "ClientCutText", "QemuExtendedKeyEvent", "Gii", "SetDesktopSize"]);
/** Never forwarded (power actions). */
const ALWAYS_DROP = new Set<RfbMessageKind>(["Xvp"]);

export interface FilterOutput {
  /** Bytes to forward to the server, in order. */
  forward: Buffer[];
  /** Messages seen in this chunk (for logs/tests). */
  messages: { kind: RfbMessageKind | "handshake"; dropped: boolean }[];
  /** Set when the stream can't be parsed; the caller must close both sides. */
  error?: string;
}

type Phase = "version" | "security" | "vncauth" | "clientinit" | "messages" | "closed";

export class RfbClientFilter {
  private buf: Buffer = Buffer.alloc(0);
  private phase: Phase = "version";
  /** Input messages dropped so far. */
  dropped = 0;
  constructor(private readonly inputAllowed: () => boolean) {}

  get state(): Phase {
    return this.phase;
  }

  push(chunk: Buffer): FilterOutput {
    const out: FilterOutput = { forward: [], messages: [] };
    if (this.phase === "closed") {
      out.error = "closed";
      return out;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const r = this.step(out);
      if (r === "need-more") break;
      if (r === "error") {
        this.phase = "closed";
        this.buf = Buffer.alloc(0);
        break;
      }
    }
    return out;
  }

  private take(n: number): Buffer {
    const b = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return Buffer.from(b);
  }

  private fail(out: FilterOutput, msg: string): "error" {
    out.error = msg;
    return "error";
  }

  private step(out: FilterOutput): "ok" | "need-more" | "error" {
    const b = this.buf;
    switch (this.phase) {
      case "version": {
        if (b.length < 12) return "need-more";
        const v = b.subarray(0, 12).toString("latin1");
        const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(v);
        if (!m) return this.fail(out, "bad protocol version");
        const minor = Number(m[2]);
        if (Number(m[1]) !== 3 || (minor !== 7 && minor !== 8)) return this.fail(out, `unsupported RFB version ${v.trim()}`);
        out.forward.push(this.take(12));
        out.messages.push({ kind: "handshake", dropped: false });
        this.phase = "security";
        return "ok";
      }
      case "security": {
        if (b.length < 1) return "need-more";
        const type = b[0]!;
        if (type === 1) this.phase = "clientinit";
        else if (type === 2) this.phase = "vncauth";
        else return this.fail(out, `unsupported security type ${type}`);
        out.forward.push(this.take(1));
        return "ok";
      }
      case "vncauth": {
        if (b.length < 16) return "need-more";
        out.forward.push(this.take(16));
        this.phase = "clientinit";
        return "ok";
      }
      case "clientinit": {
        if (b.length < 1) return "need-more";
        out.forward.push(this.take(1));
        this.phase = "messages";
        return "ok";
      }
      case "messages":
        return this.message(out);
      default:
        return this.fail(out, "closed");
    }
  }

  /** Length of the client message at the head of the buffer, or null if more bytes are needed. */
  private messageLength(): { kind: RfbMessageKind; len: number } | null | { error: string } {
    const b = this.buf;
    if (b.length < 1) return null;
    const type = b[0]!;
    const need = (n: number) => (b.length >= n ? true : false);
    switch (type) {
      case 0:
        return { kind: "SetPixelFormat", len: 20 };
      case 2:
        if (!need(4)) return null;
        return { kind: "SetEncodings", len: 4 + 4 * b.readUInt16BE(2) };
      case 3:
        return { kind: "FramebufferUpdateRequest", len: 10 };
      case 4:
        return { kind: "KeyEvent", len: 8 };
      case 5:
        return { kind: "PointerEvent", len: 6 };
      case 6: {
        if (!need(8)) return null;
        // Negative length = extended clipboard (payload |len| bytes).
        const n = Math.abs(b.readInt32BE(4));
        if (n > 64 * 1024 * 1024) return { error: "clipboard message too large" };
        return { kind: "ClientCutText", len: 8 + n };
      }
      case 150:
        return { kind: "EnableContinuousUpdates", len: 10 };
      case 248: {
        if (!need(9)) return null;
        const n = b[8]!;
        if (n > 64) return { error: "fence payload too large" };
        return { kind: "ClientFence", len: 9 + n };
      }
      case 251: {
        if (!need(8)) return null;
        return { kind: "SetDesktopSize", len: 8 + 16 * b[6]! };
      }
      case 250:
        return { kind: "Xvp", len: 4 };
      case 253: {
        if (!need(4)) return null;
        const bigEndian = (b[1]! & 0x80) !== 0;
        const n = bigEndian ? b.readUInt16BE(2) : b.readUInt16LE(2);
        return { kind: "Gii", len: 4 + n };
      }
      case 255: {
        if (!need(2)) return null;
        const sub = b[1]!;
        if (sub === 0) return { kind: "QemuExtendedKeyEvent", len: 12 };
        if (sub === 1) {
          if (!need(4)) return null;
          return { kind: "QemuAudio", len: b.readUInt16BE(2) === 2 ? 10 : 4 };
        }
        return { error: `unknown QEMU message subtype ${sub}` };
      }
      default:
        return { error: `unknown client message type ${type}` };
    }
  }

  private message(out: FilterOutput): "ok" | "need-more" | "error" {
    const m = this.messageLength();
    if (m === null) return "need-more";
    if ("error" in m) return this.fail(out, m.error);
    if (this.buf.length < m.len) return "need-more";
    const bytes = this.take(m.len);
    const drop = ALWAYS_DROP.has(m.kind) || (INPUT_KINDS.has(m.kind) && !this.inputAllowed());
    if (drop) this.dropped++;
    else out.forward.push(bytes);
    out.messages.push({ kind: m.kind, dropped: drop });
    return "ok";
  }
}
