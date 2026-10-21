/**
 * Phase 3 "beyond pixels" end-to-end, scripted (no LLM), against the real desktop image:
 *   DEV_DOCKER=1 scripts/dev pnpm --filter @deskhand/manager test:e2e
 *   (DESKHAND_E2E_IMAGE=deskhand-desktop:dev-p3 to test another tag; default deskhand-desktop:dev)
 * Checks the effect inside the desktop, not just tool responses:
 * - browser_* fills and submits the contact form in the desktop's visible Chromium; the submitted values
 *   are read back from Chromium inside the desktop; the dashboard thumbnail shows it meanwhile.
 * - browser_* follows the tab the user sees; file uploads read desktop paths; downloads land in ~/Downloads;
 *   closing Chromium re-attaches with a note.
 * - desktop_exec launches GTK (mousepad, pcmanfm) and Qt (FeatherPad) apps; ui_tree returns named elements
 *   with click points for Chromium, GTK and Qt; a native edit through ui_tree points is saved to disk.
 * - Takeover blocks pixels, browser_* and desktop_exec; hand-back rejects the waiting calls; all logged.
 * Everything is labelled owner=deskhand-dev with a per-run instance and removed afterwards.
 */
import Docker from "dockerode";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LABELS } from "@deskhand/shared";
import { api, connectMcp, imagesOf, startManager, textOf, waitFor, type TestManager } from "../helpers.js";

const IMAGE = process.env.DESKHAND_E2E_IMAGE ?? "deskhand-desktop:dev";
const docker = new Docker();
const instance = `e${Math.random().toString(36).slice(2, 8)}`;
const network = `deskhand-e2e-${instance}`;

let t: TestManager;
let client: Client;
let terminate: () => Promise<void>;
let id: string;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  return { r, text: textOf(r), isError: !!r.isError };
}

async function exec(command: string, timeout = 30): Promise<string> {
  const { text, isError } = await call("desktop_exec", { command, timeout });
  expect(isError, text).toBe(false);
  const m = /stdout:\n([\s\S]*?)(?:\nstderr:|$)/.exec(text);
  return m ? m[1]!.trim() : "";
}

/** The ref of the first snapshot line matching `re`, e.g. `textbox "Email" [ref=e12]`. */
function ref(snapshot: string, re: RegExp): string {
  const line = snapshot.split("\n").find((l) => re.test(l));
  const m = line && /\[ref=([^\]]+)\]/.exec(line);
  if (!m) throw new Error(`no ref for ${re} in:\n${snapshot}`);
  return m[1]!;
}

/** The @x,y click point of the first ui_tree line matching `re`. */
function point(tree: string, re: RegExp): [number, number] {
  const line = tree.split("\n").find((l) => re.test(l));
  const m = line && /@(\d+),(\d+)/.exec(line);
  if (!m) throw new Error(`no point for ${re} in:\n${tree}`);
  return [Number(m[1]), Number(m[2])];
}

/** Pages open in the desktop's Chromium, read inside the desktop (the debugging port is container-local). */
async function chromiumPages(): Promise<Array<{ url: string; title: string; type: string }>> {
  return JSON.parse(await exec("curl -s http://127.0.0.1:9222/json/list")).filter((p: { type: string }) => p.type === "page");
}

beforeAll(async () => {
  await docker.getImage(IMAGE).inspect(); // fail fast with a clear error if the image isn't built
  t = await startManager({
    env: {
      DESKHAND_RUNTIME: "docker",
      DESKHAND_OWNER_LABEL: "deskhand-dev",
      DESKHAND_INSTANCE: instance,
      DESKHAND_NETWORK: network,
      DESKHAND_DESKTOP_IMAGE: IMAGE,
      DESKHAND_CONTAINER_PREFIX: `dhe2e-${instance}-`,
      DESKHAND_MAX_DESKTOPS: "2",
      DESKHAND_HEALTH_INTERVAL: "1s",
      DESKHAND_START_TIMEOUT: "90s",
      DESKHAND_LOCK_WAIT: "30s",
    },
  });
  const c = await connectMcp(t.url, t.token, "phase3-e2e");
  client = c.client;
  terminate = () => c.transport.terminateSession();
  const s = await call("desktop_start", { name: "phase3-e2e" });
  id = /Desktop (\w+) is ready/.exec(s.text)![1]!;
}, 180_000);

afterAll(async () => {
  await terminate?.().catch(() => undefined);
  await t?.close().catch(() => undefined);
  const all = await docker.listContainers({ all: true, filters: { label: ["owner=deskhand-dev", `${LABELS.instance}=${instance}`] } });
  for (const c of all) await docker.getContainer(c.Id).remove({ force: true }).catch(() => undefined);
  await docker.getNetwork(network).remove().catch(() => undefined);
}, 120_000);

describe("phase 3 on the real desktop image", { timeout: 180_000 }, () => {
  it("fills and submits a web form through browser_* in the visible Chromium", async () => {
    const nav = await call("browser_navigate", { url: "file:///opt/deskhand/testpages/form.html" });
    expect(nav.isError, nav.text).toBe(false);
    expect(nav.text).toContain("Contact form");
    const snap = (await call("browser_snapshot")).text;
    const filled = await call("browser_fill_form", {
      fields: [
        { target: ref(snap, /textbox "Full name"/), name: "Full name", type: "textbox", value: "Ada Lovelace" },
        { target: ref(snap, /textbox "Email"/), name: "Email", type: "textbox", value: "ada@example.org" },
        { target: ref(snap, /combobox "Country"/), name: "Country", type: "combobox", value: "Japan" },
        { target: ref(snap, /radio "Pro"/), name: "Pro", type: "radio", value: "true" },
        { target: ref(snap, /checkbox "Send me the newsletter"/), name: "Newsletter", type: "checkbox", value: "true" },
        { target: ref(snap, /textbox "Message"/), name: "Message", type: "textbox", value: "Hello from deskhand" },
      ],
    });
    expect(filled.isError, filled.text).toBe(false);
    // The dashboard's thumbnail endpoint shows the filled form (same screen, not a hidden browser).
    const thumb = await fetch(`${t.url}/api/desktops/${id}/thumbnail`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toMatch(/^image\//);
    const click = await call("browser_click", { target: ref(snap, /button "Send message"/), element: "Send message button" });
    expect(click.isError, click.text).toBe(false);

    // Inside the desktop: Chromium's visible page is the result page with exactly these values.
    const done = await waitFor(async () => (await chromiumPages()).find((p) => p.url.includes("form-done.html")), { timeout: 15_000, what: "form-done page" });
    expect(Object.fromEntries(new URL(done.url).searchParams)).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.org",
      country: "jp",
      plan: "pro",
      newsletter: "yes",
      message: "Hello from deskhand",
    });
    expect(done.title).toBe("Form received");
    // The screen (what the user and the dashboard see) shows it too, per the accessibility tree.
    const tree = (await call("ui_tree", { window: "Chromium" })).text;
    expect(tree).toMatch(/heading "Form received" @\d+,\d+/);
    // And the action log has the browser calls with screenshots.
    const log = (await api(t, "GET", `/api/desktops/${id}/log`)).data.entries as Array<{ tool: string; outcome: string }>;
    for (const tool of ["browser_navigate", "browser_snapshot", "browser_fill_form", "browser_click"]) expect(log.find((e) => e.tool === tool)?.outcome, tool).toBe("ok");
  });

  it("acts on the tab the user sees, also after tabs change outside Playwright", async () => {
    await exec("chromium file:///opt/deskhand/testpages/slider.html >/dev/null 2>&1; sleep 2");
    expect((await call("browser_snapshot")).text).toMatch(/slider "Test slider"/);
    await call("key", { text: "ctrl+1" });
    const back = (await call("browser_snapshot")).text;
    expect(back).toContain("Form received");
    expect(back).not.toMatch(/slider "Test slider"/);
    await call("key", { text: "ctrl+2" });
    await call("browser_tabs", { action: "close" });
  });

  it("uploads desktop files and leaves downloads in the desktop's ~/Downloads", async () => {
    await exec("printf 'upload me' > ~/Documents/up.txt; rm -f ~/Downloads/deskhand-dl.txt");
    const page = `data:text/html,<input type=file id=f aria-label=Pick><a id=dl download="deskhand-dl.txt" href="data:text/plain,downloaded">Download</a>`;
    await call("browser_navigate", { url: page });
    const snap = (await call("browser_snapshot")).text;
    const chooser = await call("browser_click", { target: ref(snap, /button "Pick"|"Pick"/), element: "file input" });
    expect(chooser.text).toMatch(/[Ff]ile chooser/);
    const up = await call("browser_file_upload", { paths: ["/home/agent/Documents/up.txt"] });
    expect(up.isError, up.text).toBe(false);
    const ev = await call("browser_evaluate", { function: "async () => { const f = document.getElementById('f').files[0]; return f.name + ':' + (await f.text()); }" });
    expect(ev.text).toContain("up.txt:upload me");
    const missing = await call("browser_file_upload", { paths: ["/home/agent/nope.txt"] });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("No such file in the desktop: /home/agent/nope.txt");
    await call("browser_click", { target: ref(snap, /link "Download"/), element: "download link" });
    expect(await waitFor(async () => (await exec("cat ~/Downloads/deskhand-dl.txt 2>/dev/null || true")) === "downloaded", { timeout: 15_000, what: "download in ~/Downloads" })).toBe(true);
  });

  it("re-attaches with a note when Chromium was closed", async () => {
    await exec("pkill -x chromium; sleep 2; pgrep -x chromium || echo gone");
    const nav = await call("browser_navigate", { url: "file:///opt/deskhand/testpages/index.html" });
    expect(nav.isError, nav.text).toBe(false);
    expect(nav.text).toContain("Chromium was closed or restarted");
    expect(nav.text).toContain("drag test set");
    expect(t.m.browsers?.connected()).toContain(id);
  });

  it("desktop_exec launches GTK and Qt apps; ui_tree names their elements with click points", async () => {
    await exec("printf 'hello e2e\\n' > ~/Documents/notes.txt");
    await exec("pcmanfm ~/Documents >/dev/null 2>&1 & featherpad >/dev/null 2>&1 & mousepad ~/Documents/notes.txt >/dev/null 2>&1 & sleep 4");
    const wins = await exec("wmctrl -l");
    expect(wins).toMatch(/notes\.txt - Mousepad/);
    expect(wins).toMatch(/Documents/);
    expect(await exec("pgrep -u agent -x featherpad >/dev/null && echo up")).toBe("up");
    const mp = (await call("ui_tree", { window: "Mousepad" })).text;
    expect(mp).toMatch(/window "~\/Documents\/notes.txt - Mousepad" app="mousepad"/);
    expect(mp).toMatch(/menu "File" @\d+,\d+ box=\[/);
    expect(mp).toMatch(/text \[editable[^\]]*\] value="hello e2e" @\d+,\d+/);
    const fm = (await call("ui_tree", { window: "pcmanfm" })).text;
    expect(fm).toMatch(/app="pcmanfm"/);
    expect(fm).toMatch(/button "Parent Folder" @\d+,\d+/);
    const fp = (await call("ui_tree", { window: "FeatherPad" })).text;
    expect(fp).toMatch(/app="FeatherPad"/);
    expect(fp).toMatch(/menu item "File" @\d+,\d+/);
    expect(fp).toMatch(/button "Open" @\d+,\d+/);
    const ch = (await call("ui_tree", { window: "Chromium" })).text;
    expect(ch).toMatch(/entry "Address and search bar"/);
    expect(ch).toMatch(/link "Range slider"/);
  });

  it("edits a native app through ui_tree click points and the edit reaches the disk", async () => {
    await exec("wmctrl -a 'notes.txt - Mousepad'; sleep 0.5");
    const tree = (await call("ui_tree", { window: "Mousepad" })).text;
    const [x, y] = point(tree, /^\s*text \[editable/);
    expect((await call("left_click", { coordinate: [x, y] })).isError).toBe(false);
    await call("key", { text: "ctrl+End" });
    await call("type", { text: "edited via ui_tree\n" });
    await call("key", { text: "ctrl+s" });
    await waitFor(async () => (await exec("cat ~/Documents/notes.txt")).includes("edited via ui_tree"), { timeout: 10_000, what: "saved edit" });
    expect(await exec("cat ~/Documents/notes.txt")).toBe("hello e2e\nedited via ui_tree");
  });

  it("takeover blocks pixels, browser_* and desktop_exec; hand-back rejects the waiting calls", async () => {
    await exec("rm -f /tmp/took-effect");
    const calls = [
      { name: "left_click", arguments: { coordinate: [640, 400] } },
      { name: "browser_navigate", arguments: { url: "file:///opt/deskhand/testpages/slider.html" } },
      { name: "desktop_exec", arguments: { command: "touch /tmp/took-effect" } },
    ];
    // While locked, every channel waits, then hand-back with a note: none of the waiting calls acts.
    const before = (await chromiumPages()).map((p) => p.url);
    expect((await api(t, "POST", `/api/desktops/${id}/lock`)).status).toBe(200);
    const pending = calls.map((c) => client.callTool(c, undefined, { timeout: 120_000 }));
    await new Promise((r) => setTimeout(r, 2000));
    expect((await api(t, "DELETE", `/api/desktops/${id}/lock`, { note: "I fixed the login" })).status).toBe(200);
    for (const [i, r] of (await Promise.all(pending)).entries()) {
      expect(textOf(r), calls[i]!.name).toContain("The user handed control back: I fixed the login");
      expect(textOf(r), calls[i]!.name).toContain("was not performed");
      expect(imagesOf(r).length, calls[i]!.name).toBe(1);
    }
    expect(await exec("test -e /tmp/took-effect && echo yes || echo no")).toBe("no");
    expect((await chromiumPages()).map((p) => p.url)).toEqual(before);

    // Held past the wait: locked_by_user on all three.
    await api(t, "POST", `/api/desktops/${id}/lock`);
    const res = await Promise.all(calls.map((c) => client.callTool(c, undefined, { timeout: 120_000 })));
    for (const [i, r] of res.entries()) {
      expect(r.isError, calls[i]!.name).toBe(true);
      expect(textOf(r), calls[i]!.name).toContain("locked_by_user");
    }
    await api(t, "DELETE", `/api/desktops/${id}/lock`, { note: null });
    expect(await exec("test -e /tmp/took-effect && echo yes || echo no")).toBe("no");

    const log = (await api(t, "GET", `/api/desktops/${id}/log`)).data.entries as Array<{ tool: string; error?: { code: string } | null }>;
    for (const c of calls) {
      const codes = log.filter((e) => e.tool === c.name).map((e) => e.error?.code);
      expect(codes, c.name).toEqual(expect.arrayContaining(["control_changed", "locked_by_user"]));
    }
  });
});
