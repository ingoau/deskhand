/**
 * Takeover blocks all three channels (plan phase 3): pixel input, browser_* (forwarded to Playwright
 * MCP, which the daemon does not gate, so the manager checks the lock) and desktop_exec. While the
 * user holds the lock all three wait, then return locked_by_user; a change of control rejects calls
 * that started before it; every call shows in the action log. Uses the fake runtime and a fake
 * browser provider standing in for the Playwright MCP connection.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DeskhandError } from "@deskhand/shared";
import type { BrowserCallResult, BrowserProvider, ResolvedDesktop } from "@deskhand/mcp";
import type { FakeRuntime } from "../src/runtime/fake.js";
import { api, connectMcp, imagesOf, startManager, textOf, waitFor, type TestManager } from "./helpers.js";

class FakeBrowser implements BrowserProvider {
  calls: Array<{ desktop: string; tool: string; args: Record<string, unknown> }> = [];
  next: ((tool: string) => Promise<BrowserCallResult>) | null = null;
  async call(rd: ResolvedDesktop, tool: string, args: Record<string, unknown>): Promise<BrowserCallResult> {
    this.calls.push({ desktop: rd.desktop.id, tool, args });
    if (this.next) return this.next(tool);
    return { content: [{ type: "text", text: `### Result\nok ${tool}` }] };
  }
}

const browser = new FakeBrowser();
let t: TestManager;
const fake = () => t.runtime as FakeRuntime;

beforeAll(async () => {
  t = await startManager({ env: { DESKHAND_LOCK_WAIT: "1s" }, fake: { lockWaitMs: 1000 }, browser });
});
afterAll(async () => {
  await t?.close();
  await (t?.runtime as FakeRuntime | undefined)?.destroy();
});
beforeEach(() => {
  browser.calls = [];
  browser.next = null;
});

async function session() {
  const c = await connectMcp(t.url, t.token);
  const s = textOf(await c.client.callTool({ name: "desktop_start", arguments: {} }));
  const id = /Desktop (\w+) is ready/.exec(s)![1]!;
  return { ...c, id };
}

const CHANNELS = [
  { name: "left_click", arguments: { coordinate: [10, 10] } },
  { name: "browser_click", arguments: { target: "e3", element: "Send button" } },
  { name: "desktop_exec", arguments: { command: "echo ran" } },
];

describe("takeover blocks pixels, browser_* and desktop_exec", () => {
  it("forwards browser calls unchanged when nobody holds the lock", async () => {
    const { client, transport, id } = await session();
    const r = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com", desktop: id } });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe("### Result\nok browser_navigate");
    expect(browser.calls).toEqual([{ desktop: id, tool: "browser_navigate", args: { url: "https://example.com" } }]);
    // Parameters deskhand strips (file names on the manager) or doesn't know are refused, not forwarded.
    const bad = await client.callTool({ name: "browser_snapshot", arguments: { filename: "/etc/passwd" } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("invalid_argument");
    expect(browser.calls).toHaveLength(1);
    // Playwright errors come back unchanged and are logged as errors.
    browser.next = async () => ({ content: [{ type: "text", text: "### Error\nError: Ref e9 not found" }], isError: true });
    const err = await client.callTool({ name: "browser_click", arguments: { target: "e9" } });
    expect(err.isError).toBe(true);
    expect(textOf(err)).toBe("### Error\nError: Ref e9 not found");
    await transport.terminateSession();
  });

  it("while locked, all three wait and then return locked_by_user without acting", async () => {
    const { client, transport, id } = await session();
    const d = fake().daemonFor(id)!;
    const inputsBefore = d.inputs.length;
    const actionsBefore = d.actionCount;
    expect((await api(t, "POST", `/api/desktops/${id}/lock`)).status).toBe(200);
    const t0 = Date.now();
    const results = await Promise.all(CHANNELS.map((c) => client.callTool(c)));
    const waited = Date.now() - t0;
    for (const [i, r] of results.entries()) {
      expect(r.isError, CHANNELS[i]!.name).toBe(true);
      expect(textOf(r), CHANNELS[i]!.name).toContain("locked_by_user");
    }
    expect(waited).toBeGreaterThanOrEqual(900); // each waited for the lock (1 s in this test)
    expect(browser.calls).toHaveLength(0);
    expect(d.inputs.length).toBe(inputsBefore);
    expect(d.actionCount).toBe(actionsBefore);
    // Read-only tools still work while locked.
    const shot = await client.callTool({ name: "screenshot", arguments: {} });
    expect(shot.isError).toBeFalsy();
    await api(t, "DELETE", `/api/desktops/${id}/lock`, { note: null });

    const log = (await api(t, "GET", `/api/desktops/${id}/log`)).data.entries as Array<{ tool: string; outcome: string; error?: { code: string } }>;
    for (const c of CHANNELS) {
      const e = log.find((x) => x.tool === c.name);
      expect(e, c.name).toBeTruthy();
      expect(e!.outcome).toBe("error");
      expect(e!.error?.code).toBe("locked_by_user");
    }
    await transport.terminateSession();
  });

  it("calls waiting on the lock are rejected when control changes (hand-back), with the note and a screenshot", async () => {
    const { client, transport, id } = await session();
    const d = fake().daemonFor(id)!;
    const inputsBefore = d.inputs.length;
    const actionsBefore = d.actionCount;
    await api(t, "POST", `/api/desktops/${id}/lock`);
    const pending = CHANNELS.map((c) => client.callTool(c));
    await new Promise((r) => setTimeout(r, 300));
    await api(t, "DELETE", `/api/desktops/${id}/lock`, { note: "filled the captcha" });
    const results = await Promise.all(pending);
    for (const [i, r] of results.entries()) {
      const s = textOf(r);
      expect(s, CHANNELS[i]!.name).toContain("was not performed");
      expect(s, CHANNELS[i]!.name).toContain("filled the captcha");
      expect(imagesOf(r).length, CHANNELS[i]!.name).toBe(1);
    }
    expect(browser.calls).toHaveLength(0);
    expect(d.inputs.length).toBe(inputsBefore);
    expect(d.actionCount).toBe(actionsBefore);
    const log = (await api(t, "GET", `/api/desktops/${id}/log`)).data.entries as Array<{ tool: string; error?: { code: string } }>;
    for (const c of CHANNELS) expect(log.find((x) => x.tool === c.name)?.error?.code, c.name).toBe("control_changed");
    // After that, all three act normally.
    for (const c of CHANNELS) {
      const r = await client.callTool(c);
      expect(r.isError, c.name).toBeFalsy();
      expect(textOf(r), c.name).not.toContain("handed control back");
    }
    expect(browser.calls.map((c) => c.tool)).toEqual(["browser_click"]);
    expect(d.inputs.length).toBe(inputsBefore + 1);
    await transport.terminateSession();
  });

  it("a takeover between calls rejects element actions but lets navigation through, with the note", async () => {
    const { client, transport, id } = await session();
    await api(t, "POST", `/api/desktops/${id}/lock`);
    await api(t, "DELETE", `/api/desktops/${id}/lock`, { note: "closed the cookie banner" });
    const click = await client.callTool({ name: "browser_click", arguments: { target: "e3" } });
    expect(textOf(click)).toContain("The user handed control back: closed the cookie banner");
    expect(textOf(click)).toContain("was not performed");
    expect(browser.calls).toHaveLength(0);

    await api(t, "POST", `/api/desktops/${id}/lock`);
    await api(t, "DELETE", `/api/desktops/${id}/lock`, { note: "logged in" });
    const nav = await client.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/inbox" } });
    expect(nav.isError).toBeFalsy();
    expect(textOf(nav)).toContain("The user handed control back: logged in");
    expect(textOf(nav)).toContain("ok browser_navigate");
    expect(imagesOf(nav)).toHaveLength(1);
    expect(browser.calls.map((c) => c.tool)).toEqual(["browser_navigate"]);
    await transport.terminateSession();
  });

  it("an unknown browser outcome is reported and noted in the next result", async () => {
    const { client, transport, id } = await session();
    browser.next = async () => {
      throw new DeskhandError("outcome_unknown");
    };
    const r = await client.callTool({ name: "browser_click", arguments: { target: "e3" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("outcome_unknown");
    browser.next = null;
    const next = await client.callTool({ name: "browser_snapshot", arguments: {} });
    expect(textOf(next)).toContain("may or may not have happened");
    expect(imagesOf(next)).toHaveLength(1);
    const log = (await api(t, "GET", `/api/desktops/${id}/log`)).data.entries as Array<{ tool: string; outcome: string; summary: string }>;
    expect(log.find((x) => x.tool === "browser_click")?.outcome).toBe("unknown");
    expect(log.find((x) => x.tool === "browser_click")?.summary).toBe("browser_click e3");
    await transport.terminateSession();
  });

  it("logs browser calls with summaries and a screenshot for actions", async () => {
    const { client, transport, id } = await session();
    await client.callTool({ name: "browser_type", arguments: { target: "e5", element: "Email", text: "a@b.c", submit: true } });
    await client.callTool({ name: "browser_snapshot", arguments: {} });
    await t.m.actionLog.flush();
    const log = (await api(t, "GET", `/api/desktops/${id}/log`)).data.entries as Array<{ id: string; tool: string; summary: string; outcome: string; actor: string }>;
    const typed = log.find((x) => x.tool === "browser_type")!;
    expect(typed.summary).toBe('browser_type "Email" ← "a@b.c" ⏎');
    expect(typed.outcome).toBe("ok");
    expect(typed.actor).toMatch(/^test-/);
    const img = await fetch(`${t.url}/api/log/${typed.id}/screenshot?thumb=1`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(img.status).toBe(200);
    expect(log.find((x) => x.tool === "browser_snapshot")).toBeTruthy();
    await waitFor(() => t.m.desktops.get(id)?.lastAction?.tool === "browser_snapshot", { what: "last action" });
    await transport.terminateSession();
  });
});
