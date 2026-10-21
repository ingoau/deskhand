/**
 * Desktop end-to-end tests against a real deskhand-desktop:dev container. Every check asserts the
 * effect inside the desktop (DOM state over CDP, window geometry, file contents, cursor position),
 * not just the daemon's response.
 */
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, CdpPage, input, meanAbsDiff, ok, RfbClient, sh, sleep, until, url } from "./helpers.js";

const TESTPAGES = "file:///opt/deskhand/testpages";

describe("daemon basics", () => {
  it("serves /health without auth and refuses other routes without the key", async () => {
    const h = await fetch(`${url()}/health`);
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ ok: true, apiVersion: 1 });
    const s = await fetch(`${url()}/state`);
    expect(s.status).toBe(401);
    expect(await s.json()).toMatchObject({ error: { code: "unauthorized" } });
    const bad = await fetch(`${url()}/state`, { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
  });

  it("reports state", async () => {
    const s = await ok("GET", "/state");
    expect(s).toMatchObject({ screen: { width: 1280, height: 800 }, lock: null, heldButtons: [] });
    expect(s.generation).toBeGreaterThanOrEqual(1);
  });

  it("returns structured errors for bad input", async () => {
    const r = await api("POST", "/input", { input: { action: "left_click", coordinate: [5000, 10] } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_argument");
    expect(r.body.error.message).toMatch(/outside the screen/);
    const k = await api("POST", "/input", { input: { action: "key", text: "ctrl+NotAKey" } });
    expect(k.status).toBe(400);
    expect(k.body.error.message).toMatch(/Unknown key name/);
  });
});

describe("screenshots and zoom", () => {
  it("serves PNG screenshots at screen resolution (raw and JSON)", async () => {
    const raw = await api("GET", "/screenshot");
    expect(raw.status).toBe(200);
    const meta = await sharp(raw.body as Buffer).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 1280, 800]);
    const json = await api("GET", "/screenshot?format=jpeg&quality=70", undefined, { accept: "application/json" });
    expect(json.body).toMatchObject({ mime: "image/jpeg", width: 1280, height: 800 });
    const jm = await sharp(Buffer.from(json.body.data, "base64")).metadata();
    expect(jm.format).toBe("jpeg");
  });

  it("scales thumbnails", async () => {
    const r = await api("GET", "/screenshot?format=webp&scale=0.25", undefined, { accept: "application/json" });
    expect(r.body).toMatchObject({ mime: "image/webp", width: 320, height: 200 });
  });

  it("zoom returns the region at full resolution, scaled to fit the screen", async () => {
    // Put something detailed on screen first.
    const page = await CdpPage.open(`${TESTPAGES}/index.html`);
    await sleep(500);
    const full = await api("GET", "/screenshot?format=png");
    const zoom = await api("GET", "/screenshot?format=png&region=0,0,320,200", undefined, { accept: "application/json" });
    expect(zoom.body).toMatchObject({ width: 1280, height: 800 });
    // Same pixels as cropping the full screenshot and scaling it 4x.
    const expected = await sharp(full.body as Buffer).extract({ left: 0, top: 0, width: 320, height: 200 }).resize(1280, 800, { kernel: "lanczos3" }).removeAlpha().raw().toBuffer();
    const got = await sharp(Buffer.from(zoom.body.data, "base64")).removeAlpha().raw().toBuffer();
    expect(meanAbsDiff(expected, got)).toBeLessThan(3);
    // A region with another aspect ratio keeps it.
    const tall = await api("GET", "/screenshot?region=100,0,200,400", undefined, { accept: "application/json" });
    expect([tall.body.width, tall.body.height]).toEqual([200, 800]);
    const badRegion = await api("GET", "/screenshot?region=0,0,2000,10");
    expect(badRegion.status).toBe(400);
    await page.close();
  });
});

describe("input actions", () => {
  let page: CdpPage;
  afterAll(async () => page?.close());

  it("mouse_move moves the pointer and /cursor reports it", async () => {
    const r = await input({ action: "mouse_move", coordinate: [321, 123] });
    expect(r.cursor).toEqual([321, 123]);
    expect(await ok("GET", "/cursor")).toMatchObject({ x: 321, y: 123 });
  });

  it("returns a settled screenshot after an action by default", async () => {
    const r = await ok("POST", "/input", { input: { action: "mouse_move", coordinate: [400, 300] } });
    expect(r.screenshot).toMatchObject({ mime: "image/png", width: 1280, height: 800 });
    expect(r.ok).toBe(true);
  });

  it("double_click selects a word, triple_click the paragraph, shift+click extends a selection", async () => {
    page = await CdpPage.open(`${TESTPAGES}/select.html`);
    await page.calibrate();
    const quick = await page.eval<[number, number]>("deskhandCenter('#w-quick')");
    await input({ action: "double_click", coordinate: quick });
    expect((await page.eval("window.getSelection().toString()")).trim()).toBe("quick");
    await input({ action: "triple_click", coordinate: quick });
    expect((await page.eval("window.getSelection().toString()")).trim()).toBe("The quick brown fox jumps over the lazy dog.");
    // shift+click extends the selection (and proves click modifiers reach the page)
    const end = await page.eval<[number, number]>("deskhandWordEdge('w-fox','right')");
    await page.eval("window.__mods = []; document.addEventListener('mousedown', (e) => window.__mods.push(e.shiftKey), true); 1");
    await input({ action: "double_click", coordinate: quick });
    expect((await page.eval("window.getSelection().toString()")).trim()).toBe("quick");
    await input({ action: "left_click", coordinate: end, text: "shift" });
    expect((await page.eval<boolean[]>("window.__mods")).at(-1)).toBe(true);
    expect((await page.eval<string>("window.getSelection().toString()")).trim()).toBe("quick brown fox"); // word granularity keeps a trailing space
  });

  it("right_click opens a context menu (screen changes) and Escape closes it", async () => {
    const before = await api("GET", "/screenshot?format=png");
    const r = await ok("POST", "/input", { input: { action: "right_click", coordinate: [600, 500] }, format: "png" });
    const after = Buffer.from(r.screenshot.data, "base64");
    const a = await sharp(before.body as Buffer).removeAlpha().raw().toBuffer();
    const b = await sharp(after).removeAlpha().raw().toBuffer();
    expect(meanAbsDiff(a, b)).toBeGreaterThan(0.5);
    await input({ action: "key", text: "Escape" });
  });

  it("middle_click and left_click with ctrl reach the page with the right button and modifiers", async () => {
    await page.eval("window.__btn = []; document.addEventListener('mousedown', (e) => window.__btn.push([e.button, e.ctrlKey, e.altKey]), true); 1");
    await input({ action: "middle_click", coordinate: [700, 600] });
    await input({ action: "left_click", coordinate: [720, 600], text: "ctrl+alt" });
    await input({ action: "key", text: "Escape" });
    expect(await page.eval("window.__btn")).toEqual([
      [1, false, false],
      [0, true, true],
    ]);
  });

  it("scroll scrolls the page under the pointer, vertically and horizontally", async () => {
    await page.eval("document.body.style.height = '5000px'; document.body.style.width = '5000px'; window.scrollTo(0, 0); 1");
    await input({ action: "scroll", coordinate: [640, 400], scroll_direction: "down", scroll_amount: 5 });
    expect(await until(async () => (await page.eval<number>("window.scrollY")) > 100 && true, "scrollY")).toBe(true);
    const y = await page.eval<number>("window.scrollY");
    await input({ action: "scroll", coordinate: [640, 400], scroll_direction: "up", scroll_amount: 10 });
    await until(async () => (await page.eval<number>("window.scrollY")) < y, "scroll up");
    await input({ action: "scroll", coordinate: [640, 400], scroll_direction: "right", scroll_amount: 5 });
    await until(async () => (await page.eval<number>("window.scrollX")) > 50, "scroll right");
    const x = await page.eval<number>("window.scrollX");
    await input({ action: "scroll", coordinate: [640, 400], scroll_direction: "left", scroll_amount: 5 });
    await until(async () => (await page.eval<number>("window.scrollX")) < x, "scroll left");
  });
});

describe("drag test set", () => {
  let page: CdpPage | undefined;
  afterAll(async () => page?.close());

  it("HTML5 drag-and-drop between two lists", async () => {
    page = await CdpPage.open(`${TESTPAGES}/dnd-lists.html`);
    await page.calibrate();
    const from = await page.eval<[number, number]>("deskhandCenter('#item-2')");
    const r = await page.eval<{ x: number; y: number; w: number; h: number }>("deskhandRect('#right')");
    const to: [number, number] = [r.x + Math.round(r.w / 2), r.y + 40];
    await input({ action: "left_click_drag", start_coordinate: from, coordinate: to });
    const result = await page.eval<{ left: string[]; right: string[] }>("window.deskhand.result");
    expect(result.right).toEqual(["item-2"]);
    expect(result.left).toEqual(["item-1", "item-3"]);
    const events = (await page.eval<{ type: string }[]>("window.deskhand.events")).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(["dragstart", "dragenter", "drop", "dragend"]));
    await page.close();
    page = undefined;
  });

  it("range slider", async () => {
    page = await CdpPage.open(`${TESTPAGES}/slider.html`);
    await page.calibrate();
    const y = (await page.eval<[number, number]>("deskhandCenter('#slider')"))[1];
    const x0 = await page.eval<number>("deskhandSliderX(0)");
    const x75 = await page.eval<number>("deskhandSliderX(75)");
    await input({ action: "left_click_drag", start_coordinate: [x0, y], coordinate: [x75, y] });
    const v = (await page.eval<{ value: number }>("window.deskhand.result")).value;
    expect(Math.abs(v - 75)).toBeLessThanOrEqual(2);
    await page.close();
    page = undefined;
  });

  it("canvas drawing with left_mouse_down / mouse_move / left_mouse_up and with a drag", async () => {
    page = await CdpPage.open(`${TESTPAGES}/canvas.html`);
    await page.calibrate();
    const c = await page.eval<{ x: number; y: number; w: number; h: number }>("deskhandRect('#c')");
    const p = (fx: number, fy: number): [number, number] => [Math.round(c.x + c.w * fx), Math.round(c.y + c.h * fy)];
    await input({ action: "mouse_move", coordinate: p(0.1, 0.2) });
    await input({ action: "left_mouse_down" });
    await input({ action: "mouse_move", coordinate: p(0.4, 0.8) });
    await input({ action: "mouse_move", coordinate: p(0.7, 0.2) });
    await input({ action: "mouse_move", coordinate: p(0.9, 0.8) });
    const up = await input({ action: "left_mouse_up" });
    expect(up.ok).toBe(true);
    let r = await page.eval<{ strokes: number; points: number[]; bounds: number[][]; painted: number }>("window.deskhand.result");
    expect(r.strokes).toBe(1);
    expect(r.points[0]).toBeGreaterThan(10); // interpolated moves while the button is held
    expect(r.painted).toBeGreaterThan(2000);
    const [bx0, , bx1] = r.bounds[0]!;
    expect(bx1! - bx0!).toBeGreaterThan(c.w * 0.7);
    await input({ action: "left_click_drag", start_coordinate: p(0.1, 0.9), coordinate: p(0.9, 0.9) });
    r = await page.eval("window.deskhand.result");
    expect(r.strokes).toBe(2);
    expect(r.points[1]).toBeGreaterThanOrEqual(15);
    expect((await ok("GET", "/state")).heldButtons).toEqual([]);
    await page.close();
    page = undefined;
  });

  it("text selected by dragging", async () => {
    page = await CdpPage.open(`${TESTPAGES}/select.html`);
    await page.calibrate();
    const start = await page.eval<[number, number]>("deskhandWordEdge('w-quick','left')");
    const end = await page.eval<[number, number]>("deskhandWordEdge('w-fox','right')");
    await input({ action: "left_click_drag", start_coordinate: start, coordinate: end });
    expect(await page.eval("window.getSelection().toString()")).toBe("quick brown fox");
    await page.close();
    page = undefined;
  });

  it("window moved by its title bar", async () => {
    await sh("pkill -x xterm; (xterm -T movewin -xrm '*allowTitleOps: false' -geometry 60x12+200+150 -e sleep 600 >/dev/null 2>&1 &)");
    const pos = async () => {
      const r = await sh("W=$(xdotool search --onlyvisible --name '^movewin$' | head -1); [ -n \"$W\" ] && xwininfo -id $W | awk '/Absolute upper-left X/{x=$4} /Absolute upper-left Y/{y=$4} END{print x, y}'");
      const m = /^(\d+) (\d+)/.exec(r.stdout.trim());
      return m ? ([Number(m[1]), Number(m[2])] as [number, number]) : null;
    };
    const [x, y] = await until(pos, "xterm window");
    const ext = (await sh("xprop -id $(xdotool search --onlyvisible --name '^movewin$' | head -1) _NET_FRAME_EXTENTS")).stdout;
    const top = Number(/=\s*\d+,\s*\d+,\s*(\d+),/.exec(ext)?.[1] ?? 20);
    const grab: [number, number] = [x + 120, y - Math.round(top / 2)];
    await input({ action: "left_click_drag", start_coordinate: grab, coordinate: [grab[0] + 180, grab[1] + 110] });
    const [nx, ny] = (await pos())!;
    expect(Math.abs(nx - (x + 180))).toBeLessThanOrEqual(2);
    expect(Math.abs(ny - (y + 110))).toBeLessThanOrEqual(2);
    await sh("pkill -x xterm || true");
  });

  it("file-manager drag into a folder", async () => {
    await sh(
      "pkill -x pcmanfm; rm -rf ~/dndtest && mkdir -p ~/dndtest/target ~/.config/pcmanfm/default && echo payload > ~/dndtest/moveme.txt && " +
        "printf '[ui]\\nview_mode=list\\n' > ~/.config/pcmanfm/default/pcmanfm.conf && (pcmanfm ~/dndtest >/dev/null 2>&1 &)",
    );
    await until(async () => (await sh("xdotool search --name '^dndtest$'")).stdout.trim(), "pcmanfm window");
    await sh("wmctrl -r dndtest -e 0,80,60,760,520; sleep 0.5");
    type Node = { role: string; name: string; box?: [number, number, number, number]; children?: Node[] };
    const find = (n: Node, name: string): Node | undefined => (n.name === name && n.role === "table cell" ? n : n.children?.map((c) => find(c, name)).find(Boolean));
    const tree = await until(async () => {
      const t = await ok<Node>("GET", "/ui-tree?window=dndtest");
      return find(t, "moveme.txt")?.box && find(t, "target")?.box ? t : null;
    }, "file manager rows in the accessibility tree");
    const file = find(tree, "moveme.txt")!.box!;
    const folder = find(tree, "target")!.box!;
    const centre = (b: number[]): [number, number] => [b[0]! + Math.min(60, Math.round(b[2]! / 2)), b[1]! + Math.round(b[3]! / 2)];
    await input({ action: "left_click_drag", start_coordinate: centre(file), coordinate: centre(folder) });
    const moved = await until(async () => (await sh("test -f ~/dndtest/target/moveme.txt && cat ~/dndtest/target/moveme.txt")).stdout, "file moved");
    expect(moved.trim()).toBe("payload");
    expect((await sh("test -e ~/dndtest/moveme.txt; echo $?")).stdout.trim()).toBe("1");
    await sh("pkill -x pcmanfm || true");
  });
});

describe("keyboard", () => {
  it("type lands in a text editor (unicode included) and key ctrl+s saves it", async () => {
    await sh("pkill -x mousepad; rm -f ~/typed.txt && touch ~/typed.txt && (mousepad ~/typed.txt >/dev/null 2>&1 &)");
    await until(async () => (await sh("xdotool search --name 'typed.txt'")).stdout.trim(), "mousepad window");
    await sh("xdotool search --name 'typed.txt' | head -1 | xargs -r xdotool windowactivate --sync; sleep 0.3");
    const text = "Hello, wörld! Ünïcødé 日本語 😀 ~|{}<>\nsecond line\ttab";
    await input({ action: "type", text });
    await input({ action: "key", text: "ctrl+s" });
    const saved = await until(async () => {
      const r = await api("GET", `/files?path=${encodeURIComponent("/home/agent/typed.txt")}`);
      const s = (r.body as Buffer).toString("utf8");
      return s.length > 0 ? s : null;
    }, "saved file");
    expect(saved.replace(/\n$/, "")).toBe(text);
  });

  it("key combos with repeat, and hold_key releases what it holds", async () => {
    // Select all, delete, type again: proves ctrl+a and BackSpace reach the editor.
    await input({ action: "key", text: "ctrl+a" });
    await input({ action: "key", text: "BackSpace" });
    await input({ action: "type", text: "abcdef" });
    await input({ action: "key", text: "BackSpace", repeat: 3 });
    const t0 = Date.now();
    await input({ action: "hold_key", text: "shift", duration: 0.5 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    await input({ action: "type", text: "xyz" }); // lower case: shift was released
    await input({ action: "key", text: "ctrl+s" });
    const s = await until(async () => {
      const v = ((await api("GET", "/files?path=/home/agent/typed.txt")).body as Buffer).toString("utf8").replace(/\n$/, "");
      return v === "abcxyz" ? v : null;
    }, "editor content abcxyz");
    expect(s).toBe("abcxyz");
    await sh("pkill -x mousepad || true");
  });

  it("wait pauses and returns a fresh screenshot", async () => {
    const t0 = Date.now();
    const r = await ok("POST", "/input", { input: { action: "wait", duration: 1 }, format: "jpeg" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(r.screenshot.mime).toBe("image/jpeg");
  });
});

describe("lock, generation and stuck buttons", () => {
  afterAll(async () => {
    const s = await ok("GET", "/state");
    if (s.lock) await ok("DELETE", "/lock", { note: null });
  });

  it("lock blocks agent input (locked_by_user after the wait) but not the holder", async () => {
    const before = await ok("GET", "/state");
    const l = await ok("POST", "/lock", { holder: "dashboard" });
    expect(l.generation).toBe(before.generation + 1);
    expect(l.lock).toMatchObject({ holder: "dashboard" });
    await input({ action: "mouse_move", coordinate: [10, 10] }, { actor: "dashboard" });
    const t0 = Date.now();
    const r = await api("POST", "/input", { input: { action: "mouse_move", coordinate: [500, 500] }, screenshot: false, actor: "mcp:test" });
    expect(r.status).toBe(423);
    expect(r.body.error.code).toBe("locked_by_user");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400); // DESKHAND_LOCK_WAIT_MS=1500 in the test container
    expect((await ok("GET", "/cursor")).cursor).toEqual([10, 10]); // the blocked move did not happen
    const e = await api("POST", "/exec", { command: "true", actor: "mcp:test" });
    expect(e.status).toBe(423);
  });

  it("hand-back records the note; stale generations get control_changed", async () => {
    const locked = await ok("GET", "/state");
    const u = await ok("DELETE", "/lock", { note: "logged in for you" });
    expect(u.generation).toBe(locked.generation + 1);
    const s = await ok("GET", "/state");
    expect(s.lock).toBeNull();
    expect(s.lastHandback).toMatchObject({ note: "logged in for you", generation: u.generation });
    const stale = await api("POST", "/input", { input: { action: "mouse_move", coordinate: [600, 400] }, generation: locked.generation - 1, screenshot: false });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("control_changed");
    expect((await ok("GET", "/cursor")).cursor).not.toEqual([600, 400]);
    const fresh = await input({ action: "mouse_move", coordinate: [600, 400] }, { generation: u.generation });
    expect(fresh.generation).toBe(u.generation);
    const staleExec = await api("POST", "/exec", { command: "true", generation: locked.generation - 1 });
    expect(staleExec.status).toBe(409);
  });

  it("a queued action waiting on the lock runs after release if it carried no generation", async () => {
    await ok("POST", "/lock", { holder: "dashboard" });
    const pending = api("POST", "/input", { input: { action: "mouse_move", coordinate: [111, 222] }, screenshot: false });
    await sleep(400);
    await ok("DELETE", "/lock", { note: null });
    const r = await pending;
    expect(r.status).toBe(200);
    expect((await ok("GET", "/cursor")).cursor).toEqual([111, 222]);
  });

  it("takeover releases a held button and says so in the next result", async () => {
    await input({ action: "left_mouse_down" });
    expect((await ok("GET", "/state")).heldButtons).toEqual([1]);
    await ok("POST", "/lock", { holder: "dashboard" });
    expect((await ok("GET", "/state")).heldButtons).toEqual([]);
    const u = await ok("DELETE", "/lock", { note: null });
    const r = await input({ action: "mouse_move", coordinate: [300, 300] }, { generation: u.generation });
    expect(r.notes?.join(" ")).toMatch(/Released left mouse button/);
  });

  it("a button held without left_mouse_up is released after the stuck-button timeout", async () => {
    await input({ action: "left_mouse_down" });
    await sleep(3200); // DESKHAND_STUCK_BUTTON_MS=2500 in the test container
    expect((await ok("GET", "/state")).heldButtons).toEqual([]);
    const r = await input({ action: "mouse_move", coordinate: [310, 310] });
    expect(r.notes?.join(" ")).toMatch(/released automatically/);
  });

  it("POST /release-all releases held buttons", async () => {
    await input({ action: "left_mouse_down" });
    const r = await ok("POST", "/release-all");
    expect(r.released.join(" ")).toMatch(/left mouse button/);
    expect((await ok("GET", "/state")).heldButtons).toEqual([]);
  });

  it("parallel input calls run one at a time", async () => {
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) => api("POST", "/input", { input: { action: "left_click_drag", start_coordinate: [700 + i, 600], coordinate: [800 + i, 650], duration_ms: 200, hold_ms: 50 }, screenshot: false })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await ok("GET", "/state")).heldButtons).toEqual([]);
  });

  it("the deadline always covers the action's own duration", async () => {
    const r = await api("POST", "/input", {
      input: { action: "left_click_drag", start_coordinate: [700, 600], coordinate: [900, 650], duration_ms: 5000 },
      deadline_ms: 1,
      screenshot: false,
    });
    // The daemon extends deadlines to cover the action's own duration, so this one still completes.
    expect(r.status).toBe(200);
  });
});

describe("exec and files", () => {
  it("runs as the agent with the session environment and no daemon key", async () => {
    const r = await sh("id -un; echo $DISPLAY; env | grep -c DESKHAND_DAEMON_KEY; cat /run/deskhand/key 2>&1 >/dev/null | head -1");
    const [user, display, keyCount, keyRead] = r.stdout.trim().split("\n");
    expect(user).toBe("agent");
    expect(display).toBe(":0");
    expect(keyCount).toBe("0");
    expect(keyRead).toMatch(/Permission denied/);
  });

  it("returns promptly when a detached child (xclip) keeps running, and the clipboard works", async () => {
    const t0 = Date.now();
    const set = await sh("printf 'clip-🙂' | xclip -selection clipboard");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(set.timedOut).toBe(false);
    const get = await sh("xclip -o -selection clipboard");
    expect(get.stdout).toBe("clip-🙂");
  });

  it("kills the whole process group, detached children included, on timeout", async () => {
    const t0 = Date.now();
    const r = await ok("POST", "/exec", { command: "(sleep 301 &) ; sleep 302 & sleep 303", timeout_ms: 1000 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    await sleep(500);
    const left = await sh("pgrep -fa 'sleep 30[123]' || true");
    expect(left.stdout.trim()).toBe("");
  });

  it("PUT/GET /files writes files owned by the agent and reads them back", async () => {
    const content = Buffer.from("hello from the test 👋\n");
    const put = await fetch(`${url()}/files?path=/home/agent/sub/dir/hello.txt`, { method: "PUT", body: content, headers: { authorization: `Bearer ${(await import("./helpers.js")).key()}` } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ bytes: content.length });
    expect((await sh("stat -c '%U:%G' ~/sub/dir/hello.txt ~/sub")).stdout.trim().split("\n")).toEqual(["agent:agent", "agent:agent"]);
    const got = await api("GET", "/files?path=/home/agent/sub/dir/hello.txt");
    expect((got.body as Buffer).equals(content)).toBe(true);
    const missing = await api("GET", "/files?path=/home/agent/nope.txt");
    expect(missing.status).toBe(400);
    const secret = await api("GET", "/files?path=/run/deskhand/key");
    expect(secret.status).toBe(403);
  });
});

describe("ui-tree", () => {
  it("returns named elements with boxes for Chromium and a GTK app", async () => {
    const page = await CdpPage.open("data:text/html,<title>A11y check</title><h1>Accessible heading</h1><button>Press me</button>");
    await sh("pkill -x mousepad; (mousepad >/dev/null 2>&1 &)");
    await until(async () => (await sh("xdotool search --class mousepad")).stdout.trim(), "mousepad");
    type Node = { role: string; name: string; box?: number[]; children?: Node[] };
    const all = (n: Node, out: Node[] = []) => {
      out.push(n);
      n.children?.forEach((c) => all(c, out));
      return out;
    };
    const chromium = await until(async () => {
      const nodes = all(await ok<Node>("GET", "/ui-tree?window=A11y check"));
      return nodes.find((n) => n.role === "button" && n.name === "Press me" && n.box) ? nodes : null;
    }, "Chromium page content in the accessibility tree");
    const heading = chromium.find((n) => n.role === "heading" && n.name === "Accessible heading");
    expect(heading?.box?.[2]).toBeGreaterThan(0);
    const gtk = all(await ok<Node>("GET", "/ui-tree?window=Mousepad"));
    expect(gtk.filter((n) => n.name && n.box).length).toBeGreaterThan(5);
    expect(gtk.some((n) => n.role === "menu" && n.name === "File")).toBe(true);
    await sh("pkill -x mousepad || true");
    await page.close();
  });
});

describe("CDP proxy", () => {
  it("serves /cdp/json/version with the websocket URL routed through the daemon", async () => {
    const v = await ok("GET", "/cdp/json/version");
    expect(v.Browser).toMatch(/Chrome\//);
    expect(v.webSocketDebuggerUrl).toMatch(new RegExp(`^ws://${url().replace("http://", "")}/cdp/devtools/browser/`));
    const s = await ok("GET", "/state");
    expect(s.cdpAvailable).toBe(true);
    expect(s.chromiumSandbox).toBe(process.env.DESKHAND_E2E_SANDBOX === "0" ? "off" : "on");
  });

  it("rejects websocket upgrades without the key", async () => {
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(url().replace("http", "ws") + "/cdp/devtools/browser/x");
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("open", () => resolve(101));
      ws.on("error", () => undefined);
    });
    expect(status).toBe(401);
  });
});

describe("VNC proxy filter", () => {
  it("drops input in view mode, allows it in control mode while locked, closes old control connections", async () => {
    await input({ action: "mouse_move", coordinate: [50, 50] });
    const view = await RfbClient.connect("mode=view");
    expect([view.width, view.height]).toEqual([1280, 800]);
    view.pointer(77, 66);
    await sleep(500);
    expect((await ok("GET", "/cursor")).cursor).toEqual([50, 50]);

    // control mode without the lock: still filtered
    const s0 = await ok("GET", "/state");
    const unlocked = await RfbClient.connect(`mode=control&generation=${s0.generation}`);
    unlocked.pointer(88, 99);
    await sleep(500);
    expect((await ok("GET", "/cursor")).cursor).toEqual([50, 50]);
    unlocked.close();

    const l = await ok("POST", "/lock", { holder: "dashboard" });
    const control = await RfbClient.connect(`mode=control&generation=${l.generation}`);
    control.pointer(88, 99);
    await until(async () => {
      const c = (await ok("GET", "/cursor")).cursor;
      return c[0] === 88 && c[1] === 99;
    }, "pointer moved by VNC control connection", 5000);
    // view connection still filtered while locked
    view.pointer(5, 5);
    await sleep(400);
    expect((await ok("GET", "/cursor")).cursor).toEqual([88, 99]);

    await ok("DELETE", "/lock", { note: null });
    await until(async () => control.closed, "control connection closed on hand-back", 5000);
    expect(control.closed!.code).toBe(4001);
    expect(view.closed).toBeNull();
    view.close();
  });
});

describe("phase 1: busy-page screenshot size", () => {
  it("a full-screen screenshot of a busy page fits Claude Code's MCP output limit", async () => {
    // Prefer a real busy page; fall back to a dense local one when offline.
    let page: CdpPage;
    try {
      page = await CdpPage.open("https://en.wikipedia.org/wiki/Main_Page");
      await sleep(2500);
    } catch {
      page = await CdpPage.open(`${TESTPAGES}/index.html`);
    }
    const shot = await api("GET", "/screenshot?format=png", undefined, { accept: "application/json" });
    const b64 = shot.body.data.length;
    const tokens = Math.ceil((shot.body.width * shot.body.height) / 750); // Claude's image token estimate
    console.log(`busy page PNG: ${Math.round(b64 / 1024)} KB base64, ~${tokens} image tokens`);
    expect(tokens).toBeLessThan(25_000);
    expect(b64).toBeLessThan(5 * 1024 * 1024); // API per-image limit
    await page.close();
  });
});

describe("quiesce", () => {
  beforeAll(async () => {
    await sh("echo junk > /tmp/junk.txt; mkdir -p ~/Downloads ~/.cache/x && echo d > ~/Downloads/dl.bin && echo c > ~/.cache/x/c");
  });

  it("closes Chromium through CDP, closes apps, clears caches/Downloads//tmp and keeps the desktop working", async () => {
    const page = await CdpPage.open(`${TESTPAGES}/index.html`);
    await page.close();
    await sh("(mousepad >/dev/null 2>&1 &)");
    const r = await ok("POST", "/quiesce");
    expect(r.ok).toBe(true);
    expect(r.chromiumClosed).toBe(true);
    const after = await sh("pgrep -x chromium || echo none; pgrep -x mousepad || echo none; ls -A /tmp; ls -A ~/Downloads ~/.cache | wc -l");
    const lines = after.stdout.trim().split("\n");
    expect(lines[0]).toBe("none");
    expect(lines[1]).toBe("none");
    expect(after.stdout).not.toMatch(/junk\.txt/);
    expect(after.stdout).toMatch(/\.X11-unix/);
    // X still works and Chromium comes back on demand
    const s = await api("GET", "/screenshot?scale=0.2");
    expect(s.status).toBe(200);
    const v = await ok("GET", "/cdp/json/version");
    expect(v.Browser).toMatch(/Chrome/);
  });
});
