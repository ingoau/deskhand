import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run, type Io } from "../../cli/src/cli.js";
import type { FakeRuntime } from "../src/runtime/fake.js";
import { startManager, waitFor, type TestManager } from "./helpers.js";

let t: TestManager;
beforeAll(async () => {
  t = await startManager({ env: { DESKHAND_BASE_PATH: "/dh" } });
});
afterAll(async () => {
  await t.close();
  await (t.runtime as FakeRuntime).destroy();
});

async function cli(args: string[], env: Record<string, string> = {}) {
  const out: Array<string | Uint8Array> = [];
  const err: string[] = [];
  const io: Io = {
    env: { DESKHAND_DATA_DIR: t.dataDir, ...env },
    stdout: { write: (s) => out.push(s), isTTY: false },
    stderr: { write: (s) => err.push(s) },
  };
  const code = await run(args, io);
  const text = out.map((s) => (typeof s === "string" ? s : Buffer.from(s).toString("latin1"))).join("");
  return { code, out: text, raw: out, err: err.join("") };
}

describe("deskhand CLI", () => {
  it("uses the admin credential from the data dir (as inside the manager container)", async () => {
    const ls = await cli(["ls"]);
    expect(ls.code).toBe(0);
    expect(ls.out).toBe("no desktops\n");
    const link = await cli(["login-link"]);
    expect(link.out).toMatch(/\/dh\/auth\/login\?code=/);
  });

  it("manages tokens", async () => {
    const c = await cli(["token", "create", "claude-laptop"]);
    expect(c.code).toBe(0);
    expect(c.out).toMatch(/^dh_/);
    expect(c.err).toContain("claude mcp add --transport http deskhand");
    expect((await cli(["token", "ls"])).out).toContain("claude-laptop");
    expect((await cli(["token", "revoke", "claude-laptop"])).code).toBe(0);
    expect((await cli(["token", "ls"])).out).not.toContain("claude-laptop");
  });

  it("lists, screenshots, stops and removes desktops; edits templates", async () => {
    const e = await cli(["template", "edit", "base"]);
    expect(e.code).toBe(0);
    const id = e.out.trim();
    await waitFor(() => t.m.desktops.get(id)?.status === "running");
    const ls = await cli(["ls"]);
    expect(ls.out).toContain(id);
    expect(ls.out).toContain("edit-base");
    const shot = await cli(["screenshot"]);
    expect(shot.code).toBe(0);
    expect(Buffer.from(shot.raw[0] as Uint8Array).subarray(1, 4).toString()).toBe("PNG");
    expect((await cli(["stop", id])).out).toBe(`${id} stopped\n`);
    expect((await cli(["rm", id])).code).toBe(0);
    expect((await cli(["template", "ls"])).out).toMatch(/base\s+v1\s+default/);
    expect((await cli(["template", "rollback", "base", "7"])).code).toBe(1);
  });

  it("works with an explicit token and URL, and explains failures", async () => {
    const r = await cli(["ls", "--json"], { DESKHAND_TOKEN: t.token, DESKHAND_URL: t.url, DESKHAND_DATA_DIR: "/nonexistent" });
    expect(JSON.parse(r.out)).toEqual([]);
    const denied = await cli(["token", "ls"], { DESKHAND_TOKEN: t.token, DESKHAND_URL: t.url });
    expect(denied.code).toBe(1);
    expect(denied.err).toContain("forbidden");
    const noCreds = await cli(["ls"], { DESKHAND_DATA_DIR: "/nonexistent", DESKHAND_URL: t.url });
    expect(noCreds.err).toContain("pass --token");
    expect((await cli(["bogus"])).code).toBe(1);
    expect((await cli(["build"])).err).toContain("not available yet");
  });
});
