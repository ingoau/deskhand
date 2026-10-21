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

  it("start creates a desktop with --memory/--cpus/--kvm; start <id> restarts", async () => {
    const rt = t.runtime as FakeRuntime;
    rt.kvm = true;
    (t.m.desktops.hardware as unknown as { kvmCache: unknown }).kvmCache = null;
    const s = await cli(["start", "--memory", "3g", "--cpus", "2", "--kvm", "--name", "cli-hw"]);
    expect(s.code, s.err).toBe(0);
    expect(s.out).toMatch(/^\w+ starting {2}base:v1 {2}3g memory, 2 cpus, kvm\n$/);
    const id = s.out.split(" ")[0]!;
    expect([...rt.containers.values()].find((c) => c.spec.id === id)!.spec).toMatchObject({ memoryBytes: 3 * 1024 ** 3, cpus: 2, kvm: true });
    await waitFor(() => t.m.desktops.get(id)?.status === "running");
    expect((await cli(["stop", id])).out).toBe(`${id} stopped\n`);
    expect((await cli(["start", id])).out).toBe(`${id} running\n`);
    expect((await cli(["start", id, "--kvm"])).err).toContain("takes no options");
    const over = await cli(["start", "--memory", "64g"]);
    expect(over.code).toBe(1);
    expect(over.err).toContain("invalid_argument");
    expect((await cli(["start", "--cpus", "lots"])).err).toContain("--cpus must be a positive number");
    expect((await cli(["rm", id])).code).toBe(0);
    rt.kvm = false;
  });

  it("shows, edits, rebuilds, diffs and rolls back templates", async () => {
    const d = await t.m.desktops.create({ sessionId: null, sessionLabel: null, actor: "test" });
    const save = (desc: string) =>
      fetch(`${t.url}/api/desktops/${d.id}/save-as-template`, {
        method: "POST",
        headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "cli-tpl", description: { summary: desc, use_when: "CLI tests" } }),
      }).then((r) => r.json());
    expect((await save("first")).version).toBe(1);
    expect((await save("second")).version).toBe(2);
    const info = await cli(["template", "info", "cli-tpl"]);
    expect(info.out).toContain("summary:     second");
    expect(info.out).toMatch(/v2\*/);
    expect((await cli(["template", "rebuild", "cli-tpl"])).err).toContain("no recipe");
    const file = `${t.dataDir}/recipe.sh`;
    (await import("node:fs")).writeFileSync(file, "echo hello > ~/hello.txt\n");
    expect((await cli(["template", "recipe", "cli-tpl", file])).out).toContain("recipe updated");
    expect((await cli(["template", "recipe", "cli-tpl"])).out).toBe("echo hello > ~/hello.txt\n");
    const rb = await cli(["template", "rebuild", "cli-tpl"]);
    expect(rb.out, rb.err).toContain("cli-tpl rebuilt as v3");
    const diff = JSON.parse((await cli(["template", "diff", "cli-tpl", "1", "2"])).out);
    expect(diff.description[0]).toMatchObject({ field: "summary", before: "first", after: "second" });
    expect((await cli(["template", "rollback", "cli-tpl"])).out).toBe("cli-tpl now points at v2\n");
    expect((await cli(["template", "ls"])).out).toMatch(/cli-tpl\s+v2 \(latest v3\)/);
    await t.m.desktops.remove(d.id, "user");
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
