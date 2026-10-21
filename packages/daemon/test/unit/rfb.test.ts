import { describe, expect, it } from "vitest";
import { RfbClientFilter } from "../../src/rfb.js";

const handshake = () => Buffer.concat([Buffer.from("RFB 003.008\n", "latin1"), Buffer.from([1]), Buffer.from([1])]);
const setPixelFormat = () => {
  const b = Buffer.alloc(20);
  b[0] = 0;
  return b;
};
const setEncodings = (encs: number[]) => {
  const b = Buffer.alloc(4 + 4 * encs.length);
  b[0] = 2;
  b.writeUInt16BE(encs.length, 2);
  encs.forEach((e, i) => b.writeInt32BE(e, 4 + 4 * i));
  return b;
};
const fbur = () => Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const key = (down: boolean, sym: number) => {
  const b = Buffer.alloc(8);
  b[0] = 4;
  b[1] = down ? 1 : 0;
  b.writeUInt32BE(sym, 4);
  return b;
};
const pointer = (mask: number, x: number, y: number) => {
  const b = Buffer.alloc(6);
  b[0] = 5;
  b[1] = mask;
  b.writeUInt16BE(x, 2);
  b.writeUInt16BE(y, 4);
  return b;
};
const cut = (text: string, extended = false) => {
  const t = Buffer.from(text, "latin1");
  const b = Buffer.alloc(8);
  b[0] = 6;
  b.writeInt32BE(extended ? -t.length : t.length, 4);
  return Buffer.concat([b, t]);
};

function run(filter: RfbClientFilter, ...chunks: Buffer[]) {
  const forwarded: Buffer[] = [];
  const kinds: string[] = [];
  let error: string | undefined;
  for (const c of chunks) {
    const r = filter.push(c);
    forwarded.push(...r.forward);
    kinds.push(...r.messages.map((m) => `${m.kind}${m.dropped ? ":dropped" : ""}`));
    error ??= r.error;
  }
  return { bytes: Buffer.concat(forwarded), kinds, error };
}

describe("RfbClientFilter", () => {
  it("forwards handshake and non-input messages in view mode, drops input", () => {
    const f = new RfbClientFilter(() => false);
    const r = run(f, handshake(), setPixelFormat(), setEncodings([0, 7, -223]), fbur(), key(true, 0x61), pointer(1, 10, 20), cut("secret"), fbur());
    expect(r.error).toBeUndefined();
    expect(r.kinds).toEqual([
      "handshake",
      "SetPixelFormat",
      "SetEncodings",
      "FramebufferUpdateRequest",
      "KeyEvent:dropped",
      "PointerEvent:dropped",
      "ClientCutText:dropped",
      "FramebufferUpdateRequest",
    ]);
    // forwarded bytes = handshake + spf + setenc + fbur + fbur
    expect(r.bytes.equals(Buffer.concat([handshake(), setPixelFormat(), setEncodings([0, 7, -223]), fbur(), fbur()]))).toBe(true);
    expect(f.dropped).toBe(3);
  });

  it("forwards input when allowed, and the decision is made per message", () => {
    let allowed = true;
    const f = new RfbClientFilter(() => allowed);
    run(f, handshake());
    const a = run(f, key(true, 0x61), pointer(0, 5, 5));
    expect(a.bytes.equals(Buffer.concat([key(true, 0x61), pointer(0, 5, 5)]))).toBe(true);
    allowed = false;
    const b = run(f, key(false, 0x61), fbur());
    expect(b.bytes.equals(fbur())).toBe(true);
  });

  it("reassembles messages split across chunks at any byte boundary", () => {
    const stream = Buffer.concat([handshake(), setEncodings([1, 2, 3, 4, 5]), pointer(1, 300, 400), cut("hello world"), fbur(), key(true, 0x62)]);
    for (let split = 1; split < stream.length; split += 3) {
      const f = new RfbClientFilter(() => true);
      const chunks: Buffer[] = [];
      for (let i = 0; i < stream.length; i += split) chunks.push(stream.subarray(i, i + split));
      const r = run(f, ...chunks);
      expect(r.error).toBeUndefined();
      expect(r.bytes.equals(stream)).toBe(true);
    }
  });

  it("frames extended clipboard (negative length) and drops it in view mode", () => {
    const f = new RfbClientFilter(() => false);
    const r = run(f, handshake(), cut("\x00\x00\x00\x01xyz", true), fbur());
    expect(r.kinds).toEqual(["handshake", "ClientCutText:dropped", "FramebufferUpdateRequest"]);
    expect(r.error).toBeUndefined();
  });

  it("handles VNC auth, continuous updates, fences, QEMU key events, xvp and desktop size", () => {
    const f = new RfbClientFilter(() => false);
    const auth = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([2]), Buffer.alloc(16, 7), Buffer.from([1])]);
    const ecu = Buffer.from([150, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
    const fence = Buffer.concat([Buffer.from([248, 0, 0, 0, 0, 0, 0, 3, 4]), Buffer.from("abcd")]);
    const qemuKey = Buffer.from([255, 0, 0, 1, 0, 0, 0, 0x61, 0, 0, 0, 30]);
    const qemuAudio = Buffer.from([255, 1, 0, 0]);
    const xvp = Buffer.from([250, 0, 1, 2]);
    const sds = Buffer.concat([Buffer.from([251, 0, 5, 0, 3, 32, 1, 0]), Buffer.alloc(16)]);
    const r = run(f, auth, ecu, fence, qemuKey, qemuAudio, xvp, sds, fbur());
    expect(r.error).toBeUndefined();
    expect(r.kinds).toEqual([
      "handshake",
      "EnableContinuousUpdates",
      "ClientFence",
      "QemuExtendedKeyEvent:dropped",
      "QemuAudio",
      "Xvp:dropped",
      "SetDesktopSize:dropped",
      "FramebufferUpdateRequest",
    ]);
  });

  it("always drops xvp, even in control mode", () => {
    const f = new RfbClientFilter(() => true);
    const r = run(f, handshake(), Buffer.from([250, 0, 1, 2]));
    expect(r.kinds).toContain("Xvp:dropped");
  });

  it("closes on unknown message types, bad versions and unsupported security", () => {
    const a = run(new RfbClientFilter(() => true), handshake(), Buffer.from([99, 0, 0, 0]));
    expect(a.error).toMatch(/unknown client message type 99/);
    const b = run(new RfbClientFilter(() => true), Buffer.from("HTTP/1.1 GET\n"));
    expect(b.error).toMatch(/version/);
    const c = run(new RfbClientFilter(() => true), Buffer.from("RFB 003.003\n"));
    expect(c.error).toMatch(/unsupported RFB version/);
    const d = run(new RfbClientFilter(() => true), Buffer.from("RFB 003.008\n"), Buffer.from([19]));
    expect(d.error).toMatch(/security type 19/);
    // after an error, nothing more is forwarded
    const f = new RfbClientFilter(() => true);
    run(f, handshake(), Buffer.from([99]));
    expect(run(f, fbur()).bytes.length).toBe(0);
  });
});
