import { describe, expect, it } from "vitest";
import { parseBind, parseConfig, resolveMemoryBudget } from "../src/config.js";
import { normalizeBasePath, parseBytes, parseDuration } from "../src/util.js";

describe("parseDuration", () => {
  it("parses units and combinations", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(7 * 86_400_000);
    expect(parseDuration("1h30m")).toBe(90 * 60_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("90")).toBe(90_000);
  });
  it("rejects garbage", () => {
    expect(() => parseDuration("soon")).toThrow();
    expect(() => parseDuration("5x")).toThrow();
    expect(() => parseDuration("10m and")).toThrow();
  });
});

describe("parseBytes", () => {
  it("parses docker-style sizes", () => {
    expect(parseBytes("2g")).toBe(2 * 1024 ** 3);
    expect(parseBytes("512m")).toBe(512 * 1024 ** 2);
    expect(parseBytes("1.5G")).toBe(1.5 * 1024 ** 3);
    expect(parseBytes("72k")).toBe(72 * 1024);
    expect(parseBytes("2gb")).toBe(2 * 1024 ** 3);
    expect(parseBytes("1024")).toBe(1024);
    expect(() => parseBytes("lots")).toThrow();
  });
});

describe("parseConfig", () => {
  it("has the plan's defaults", () => {
    const c = parseConfig({});
    expect(c.maxDesktops).toBe(8);
    expect(c.memoryBudget).toEqual({ fraction: 0.8 });
    expect(c.desktopMemoryBytes).toBe(2 * 1024 ** 3);
    expect(c.desktopCpus).toBe(1.5);
    expect(c.idleTimeoutMs).toBe(30 * 60_000);
    expect(c.stoppedRetentionMs).toBe(86_400_000);
    expect(c.logRetentionMs).toBe(7 * 86_400_000);
    expect(c.templateVersions).toBe(5);
    expect(c.templateRepo).toBe("deskhand-template");
    expect(c.templateStaleMs).toBe(14 * 86_400_000);
    expect(c.templateCarryPaths).toEqual([".config/chromium", ".mozilla", ".local/share/keyrings", ".pki"]);
    expect(c.templateAutoRebuild).toBe(true);
    expect(c.bind).toEqual({ host: "127.0.0.1", port: 7480 });
    expect(c.basePath).toBe("");
    expect(c.auth).toBe(true);
    expect(c.dataDir).toBe("/data");
    expect(c.network).toBe("deskhand-desktops");
    expect(c.desktopImage).toMatch(/^ghcr\.io\/ingoau\/deskhand-desktop:\d+\.\d+\.\d+/);
    expect(c.mountAllow).toEqual([]);
    expect(c.mountDeny).toEqual([]);
    expect(c.dockerSocketPaths).toContain("/var/run/docker.sock");
    expect(c.tz).toBeNull();
  });

  it("reads every variable", () => {
    const c = parseConfig({
      DESKHAND_MAX_DESKTOPS: "3",
      DESKHAND_MEMORY_BUDGET: "12g",
      DESKHAND_DESKTOP_MEMORY: "1g",
      DESKHAND_DESKTOP_CPUS: "0.5",
      DESKHAND_IDLE_TIMEOUT: "10m",
      DESKHAND_STOPPED_RETENTION: "2h",
      DESKHAND_LOG_RETENTION: "1d",
      DESKHAND_TEMPLATE_VERSIONS: "2",
      DESKHAND_BIND: "0.0.0.0:7481",
      DESKHAND_BASE_PATH: "/deskhand/",
      DESKHAND_AUTH: "off",
      TZ: "Australia/Sydney",
      LANG: "en_AU.UTF-8",
      DESKHAND_DATA_DIR: "/tmp/x",
      DESKHAND_DESKTOP_IMAGE: "deskhand-desktop:dev",
      DESKHAND_NETWORK: "n1",
      DESKHAND_MOUNT_ALLOW: "/home/me/work, /srv/data/",
      DESKHAND_MOUNT_DENY: "/home/me/.ssh",
    });
    expect(c.maxDesktops).toBe(3);
    expect(c.memoryBudget).toEqual({ bytes: 12 * 1024 ** 3 });
    expect(c.desktopMemoryBytes).toBe(1024 ** 3);
    expect(c.desktopCpus).toBe(0.5);
    expect(c.idleTimeoutMs).toBe(600_000);
    expect(c.stoppedRetentionMs).toBe(7_200_000);
    expect(c.logRetentionMs).toBe(86_400_000);
    expect(c.templateVersions).toBe(2);
    expect(c.bind).toEqual({ host: "0.0.0.0", port: 7481 });
    expect(c.basePath).toBe("/deskhand");
    expect(c.auth).toBe(false);
    expect(c.tz).toBe("Australia/Sydney");
    expect(c.lang).toBe("en_AU.UTF-8");
    expect(c.desktopImage).toBe("deskhand-desktop:dev");
    expect(c.network).toBe("n1");
    expect(c.mountAllow).toEqual(["/home/me/work", "/srv/data"]);
    expect(c.mountDeny).toEqual(["/home/me/.ssh"]);
  });

  it("reads the template options", () => {
    const c = parseConfig({
      DESKHAND_TEMPLATE_REPO: "registry.local/team/deskhand-template",
      DESKHAND_TEMPLATE_STALE_AFTER: "3d",
      DESKHAND_TEMPLATE_CARRY: "~/.config/chromium, .local/share/keyrings/",
      DESKHAND_TEMPLATE_AUTO_REBUILD: "off",
      DESKHAND_RECIPE_TIMEOUT: "5m",
    });
    expect(c).toMatchObject({
      templateRepo: "registry.local/team/deskhand-template",
      templateStaleMs: 3 * 86_400_000,
      templateCarryPaths: [".config/chromium", ".local/share/keyrings"],
      templateAutoRebuild: false,
      recipeTimeoutMs: 300_000,
    });
    expect(() => parseConfig({ DESKHAND_TEMPLATE_CARRY: "/etc" })).toThrow(/relative to the agent's home/);
    expect(() => parseConfig({ DESKHAND_TEMPLATE_REPO: "Bad Repo" })).toThrow(/DESKHAND_TEMPLATE_REPO/);
  });

  it("accepts a percentage memory budget and resolves it against host memory", () => {
    const c = parseConfig({ DESKHAND_MEMORY_BUDGET: "50%" });
    expect(resolveMemoryBudget(c, 32 * 1024 ** 3)).toBe(16 * 1024 ** 3);
    expect(resolveMemoryBudget(parseConfig({}), 10 * 1024 ** 3)).toBe(8 * 1024 ** 3);
  });

  it("explains bad values", () => {
    expect(() => parseConfig({ DESKHAND_MAX_DESKTOPS: "lots" })).toThrow(/DESKHAND_MAX_DESKTOPS/);
    expect(() => parseConfig({ DESKHAND_IDLE_TIMEOUT: "forever" })).toThrow(/DESKHAND_IDLE_TIMEOUT/);
    expect(() => parseConfig({ DESKHAND_AUTH: "maybe" })).toThrow(/DESKHAND_AUTH/);
    expect(() => parseConfig({ DESKHAND_MEMORY_BUDGET: "big" })).toThrow(/DESKHAND_MEMORY_BUDGET/);
    expect(() => parseConfig({ DESKHAND_MOUNT_DENY: "relative/path" })).toThrow(/absolute/);
    expect(() => parseConfig({ DESKHAND_BASE_PATH: "/a b" })).toThrow(/BASE_PATH/);
  });
});

describe("parseBind and normalizeBasePath", () => {
  it("parses bind addresses", () => {
    expect(parseBind("127.0.0.1:7480")).toEqual({ host: "127.0.0.1", port: 7480 });
    expect(parseBind(":7480")).toEqual({ host: "0.0.0.0", port: 7480 });
    expect(parseBind("7480")).toEqual({ host: "127.0.0.1", port: 7480 });
    expect(parseBind("[::1]:7480")).toEqual({ host: "::1", port: 7480 });
    expect(() => parseBind("nonsense")).toThrow();
  });
  it("normalises base paths", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("deskhand")).toBe("/deskhand");
    expect(normalizeBasePath("/a/b/")).toBe("/a/b");
    expect(normalizeBasePath("//a//b")).toBe("/a/b");
  });
});
