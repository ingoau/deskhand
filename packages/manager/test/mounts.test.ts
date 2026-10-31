import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DeskhandError } from "@deskhand/shared";
import { checkTarget, evaluate, isWithin, MountPolicy, normalizeHostPath, type PolicyContext } from "../src/mounts.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import type { PathResolution } from "../src/runtime/types.js";
import { tmpDir } from "./helpers.js";

const res = (input: string, resolved = input, type: PathResolution["type"] = "dir"): PathResolution => ({ input, resolved, exists: type !== "missing", type });
const ctx = (o: Partial<PolicyContext> = {}): PolicyContext => ({ allow: [], deny: [], sockets: ["/var/run/docker.sock", "/run/docker.sock"], ...o });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as DeskhandError).code;
  }
  return "ok";
};

describe("mount policy rules", () => {
  it("normalises host paths and rejects unsafe characters", () => {
    expect(normalizeHostPath("/home/me/work/")).toBe("/home/me/work");
    expect(normalizeHostPath("/home/me/../me/work")).toBe("/home/me/work");
    expect(code(() => normalizeHostPath("relative"))).toBe("invalid_argument");
    expect(code(() => normalizeHostPath("/a:b"))).toBe("invalid_argument");
  });

  it("isWithin", () => {
    expect(isWithin("/a/b", "/a")).toBe(true);
    expect(isWithin("/a", "/a")).toBe(true);
    expect(isWithin("/ab", "/a")).toBe(false);
    expect(isWithin("/x", "/")).toBe(true);
  });

  it("always refuses the Docker socket, paths resolving to it and directories containing it", () => {
    const m = { forMount: true, mustExist: true };
    expect(code(() => evaluate("/var/run/docker.sock", res("/var/run/docker.sock", "/run/docker.sock", "socket"), ctx(), m))).toBe("mount_refused");
    expect(code(() => evaluate("/home/me/sock", res("/home/me/sock", "/run/docker.sock", "socket"), ctx(), m))).toBe("mount_refused");
    expect(code(() => evaluate("/home/me/link", res("/home/me/link", "/run", "dir"), ctx(), m))).toBe("mount_refused");
    expect(code(() => evaluate("/", res("/"), ctx(), m))).toBe("mount_refused");
    expect(code(() => evaluate("/srv/x/docker.sock", res("/srv/x/docker.sock", "/srv/x/docker.sock", "socket"), ctx(), m))).toBe("mount_refused");
    // A normal directory is fine.
    expect(evaluate("/home/me/work", res("/home/me/work"), ctx(), m)).toBe("/home/me/work");
  });

  it("applies deny lists (including parents of denied paths) and allow lists after resolution", () => {
    const m = { forMount: true, mustExist: true };
    const deny = ctx({ deny: ["/home/me/.ssh"] });
    expect(code(() => evaluate("/home/me/.ssh", res("/home/me/.ssh"), deny, m))).toBe("mount_refused");
    expect(code(() => evaluate("/home/me/link", res("/home/me/link", "/home/me/.ssh/keys"), deny, m))).toBe("mount_refused");
    expect(code(() => evaluate("/home/me", res("/home/me"), deny, m))).toBe("mount_refused");
    expect(evaluate("/home/me/work", res("/home/me/work"), deny, m)).toBe("/home/me/work");
    const allow = ctx({ allow: ["/home/me/work"] });
    expect(evaluate("/home/me/work/a", res("/home/me/work/a"), allow, m)).toBe("/home/me/work/a");
    expect(code(() => evaluate("/home/me/other", res("/home/me/other"), allow, m))).toBe("mount_refused");
    // A symlink inside the allowed dir pointing outside it is refused.
    expect(code(() => evaluate("/home/me/work/escape", res("/home/me/work/escape", "/etc"), allow, m))).toBe("mount_refused");
  });

  it("protects host system directories and home dotfiles unless allow-listed", () => {
    const file = { forMount: false, mustExist: false };
    const m = { forMount: true, mustExist: true };
    for (const p of ["/etc/ld.so.preload", "/root/.profile", "/usr/local/bin/x", "/var/lib/docker/x", "/home/me/.bashrc", "/home/me/.ssh/authorized_keys"]) {
      expect(code(() => evaluate(p, res(p), ctx(), file)), p).toBe("mount_refused");
    }
    // Through a symlink, too.
    expect(code(() => evaluate("/home/me/work/rc", res("/home/me/work/rc", "/home/me/.bashrc"), ctx(), file))).toBe("mount_refused");
    expect(code(() => evaluate("/home/me", res("/home/me"), ctx(), m))).toBe("mount_refused");
    expect(code(() => evaluate("/home", res("/home"), ctx(), m))).toBe("mount_refused");
    expect(code(() => evaluate("/var", res("/var"), ctx(), m))).toBe("mount_refused");
    expect(evaluate("/home/me/work/.git/config", res("/home/me/work/.git/config"), ctx(), file)).toBe("/home/me/work/.git/config");
    expect(evaluate("/home/me/out.png", res("/home/me/out.png"), ctx(), file)).toBe("/home/me/out.png");
    // An explicit allow-list entry is the operator's choice.
    expect(evaluate("/home/me", res("/home/me"), ctx({ allow: ["/home/me"] }), m)).toBe("/home/me");
  });

  it("refuses missing paths and targets that would hide the desktop's system directories", () => {
    expect(code(() => evaluate("/nope", res("/nope", "/nope", "missing"), ctx(), { forMount: true, mustExist: true }))).toBe("invalid_argument");
    for (const t of ["/etc", "/usr/share", "/tmp", "/home", "/home/agent", "/proc/1", "/var"]) expect(code(() => checkTarget(t)), t).toBe("mount_refused");
    for (const t of ["/home/me/work", "/tmp/project", "/srv/data", "/home/agent/work"]) expect(code(() => checkTarget(t)), t).toBe("ok");
  });
});

describe("MountPolicy with real symlinks", () => {
  const dir = tmpDir("deskhand-mounts-");
  const runtime = new FakeRuntime();
  fs.mkdirSync(path.join(dir, "work"));
  fs.mkdirSync(path.join(dir, "secret"));
  fs.writeFileSync(path.join(dir, "work", "a.txt"), "hi");
  fs.writeFileSync(path.join(dir, "fake-docker.sock"), "");
  fs.symlinkSync(path.join(dir, "secret"), path.join(dir, "work", "to-secret"));
  fs.symlinkSync(path.join(dir, "fake-docker.sock"), path.join(dir, "work", "sock-link"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("resolves through symlinks before checking deny and socket rules", async () => {
    const p = new MountPolicy({ mountAllow: [], mountDeny: [path.join(dir, "secret")], dockerSocketPaths: [path.join(dir, "fake-docker.sock")] }, runtime);
    const ok = await p.checkMounts([{ path: path.join(dir, "work"), write: true }]);
    expect(ok).toEqual([{ target: path.join(dir, "work"), source: path.join(dir, "work"), write: true }]);
    await expect(p.checkMounts([{ path: path.join(dir, "work", "to-secret") }])).rejects.toMatchObject({ code: "mount_refused" });
    await expect(p.checkMounts([{ path: path.join(dir, "work", "sock-link") }])).rejects.toMatchObject({ code: "mount_refused" });
    await expect(p.checkReadFile(path.join(dir, "work", "sock-link"))).rejects.toMatchObject({ code: "mount_refused" });
    await expect(p.checkMounts([{ path: path.join(dir, "missing") }])).rejects.toMatchObject({ code: "invalid_argument" });
    expect(await p.checkReadFile(path.join(dir, "work", "a.txt"))).toBe(path.join(dir, "work", "a.txt"));
    expect(await p.checkWriteFile(path.join(dir, "work", "new.txt"))).toBe(path.join(dir, "work", "new.txt"));
    await expect(p.checkWriteFile(path.join(dir, "secret", "x.txt"))).rejects.toMatchObject({ code: "mount_refused" });
    await expect(p.checkWriteFile(path.join(dir, "nodir", "x.txt"))).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("allow lists restrict mounts to the listed trees", async () => {
    const p = new MountPolicy({ mountAllow: [path.join(dir, "work")], mountDeny: [], dockerSocketPaths: [] }, runtime);
    await expect(p.checkMounts([{ path: path.join(dir, "work") }])).resolves.toHaveLength(1);
    await expect(p.checkMounts([{ path: path.join(dir, "secret") }])).rejects.toMatchObject({ code: "mount_refused" });
    await expect(p.checkMounts([{ path: path.join(dir, "work", "to-secret") }])).rejects.toMatchObject({ code: "mount_refused" });
  });
});
