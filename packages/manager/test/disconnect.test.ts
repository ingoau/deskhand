/**
 * Claude Code (2.1.x) exits without DELETE /mcp; the only sign the session ended is its standalone
 * SSE stream (GET /mcp) closing. The manager ends such sessions after DESKHAND_SESSION_DISCONNECT_GRACE.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FakeRuntime } from "../src/runtime/fake.js";
import { connectMcp, startManager, textOf, waitFor, type TestManager } from "./helpers.js";

let t: TestManager;

beforeAll(async () => {
  t = await startManager({ env: { DESKHAND_SESSION_DISCONNECT_GRACE: "600ms" } });
});
afterAll(async () => {
  await t?.close();
  await (t?.runtime as FakeRuntime | undefined)?.destroy();
});

function idOf(r: { content?: unknown }): string {
  const m = /Desktop (\w+) is ready/.exec(textOf(r));
  if (!m) throw new Error(`desktop_start failed: ${textOf(r)}`);
  return m[1]!;
}

describe("session end without DELETE", () => {
  it("removes the session's desktops once its event stream has stayed closed past the grace period", async () => {
    const a = await connectMcp(t.url, t.token, "gone");
    const b = await connectMcp(t.url, t.token, "stays");
    const ida = idOf(await a.client.callTool({ name: "desktop_start", arguments: {} }));
    const idb = idOf(await b.client.callTool({ name: "desktop_start", arguments: {} }));
    await waitFor(() => t.m.mcp.sessionCount === 2, { what: "two sessions" });

    // Like a client process exiting: the connection (and its GET stream) just drops.
    await a.transport.close();
    await waitFor(() => t.m.desktops.get(ida) === undefined, { timeout: 5000, what: "disconnected session's desktop removed" });
    expect(t.m.desktops.get(idb)).toBeDefined();

    // The live session (stream still open, idle) is untouched well past the grace period.
    await new Promise((r) => setTimeout(r, 1500));
    expect(t.m.desktops.get(idb)).toBeDefined();
    const again = await b.client.callTool({ name: "desktop_list", arguments: {} });
    expect(textOf(again)).toContain(idb);
    await b.transport.terminateSession();
  });
});
