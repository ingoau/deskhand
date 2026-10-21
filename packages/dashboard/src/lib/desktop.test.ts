import { describe, expect, it } from "vitest";
import type { DesktopSummary } from "@deskhand/shared";
import { attentionList, displayState, displayTitle, filterDesktops, hardwareMarks, lockIsLong, matchesQuery, metaLine, sortDesktops, statusLine, tabCounts, templateHardwareLabel, uptimeLabel } from "./desktop";
import { createState, publicDesktop } from "../../mock/data";

const now = Date.parse("2026-10-21T21:16:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const M = 60_000;

function desktop(p: Partial<DesktopSummary> = {}): DesktopSummary {
  return {
    id: "aaaa",
    name: "deskhand-aaaa",
    title: "linear-triage",
    session: "claude-laptop/9f2c",
    sessionIndex: 0,
    template: "research",
    templateVersion: 2,
    status: "running",
    persistent: false,
    attention: null,
    lock: null,
    generation: 1,
    lastHandback: null,
    lastAction: { tool: "left_click", summary: "left_click [812, 344]", at: ago(20_000) },
    createdAt: ago(42 * M + 5000),
    startedAt: ago(42 * M),
    stoppedAt: null,
    lastActivityAt: ago(20_000),
    screen: { width: 1280, height: 800 },
    mounts: [],
    cpuPercent: 10,
    memoryBytes: 1e9,
    diskBytes: 1e8,
    ...p,
  };
}

describe("display state and lines", () => {
  it("running shows the last action", () => {
    const d = desktop();
    expect(displayState(d)).toBe("running");
    expect(uptimeLabel(d, now)).toBe("42m");
    expect(statusLine(d, now)).toBe("left_click [812, 344]");
    expect(statusLine(desktop({ lastAction: null }), now)).toBe("idle");
  });

  it("attention shows waiting on you", () => {
    const d = desktop({ attention: { reason: "CAPTCHA", since: ago(2 * M), timeoutAt: null } });
    expect(displayState(d)).toBe("attention");
    expect(statusLine(d, now)).toBe("waiting on you");
  });

  it("control wins over attention and shows how long", () => {
    const d = desktop({
      attention: { reason: "x", since: ago(40 * M), timeoutAt: null },
      lock: { holder: "dashboard", since: ago(34 * M), generation: 4 },
      startedAt: ago(65 * M),
    });
    expect(displayState(d)).toBe("control");
    expect(statusLine(d, now)).toBe("you have control · 34m");
    expect(uptimeLabel(d, now)).toBe("1h05m");
    expect(lockIsLong(d, now)).toBe(true);
    expect(lockIsLong(desktop({ lock: { holder: "dashboard", since: ago(5 * M), generation: 2 } }), now)).toBe(false);
  });

  it("stopped shows run time and idle time", () => {
    const d = desktop({ status: "stopped", startedAt: ago(160 * M), stoppedAt: ago(30 * M), lastActivityAt: ago(60 * M) });
    expect(displayState(d)).toBe("stopped");
    expect(uptimeLabel(d, now)).toBe("2h10m");
    expect(statusLine(d, now)).toBe("stopped · idle 30m");
  });

  it("starting shows m:ss and template@version", () => {
    const d = desktop({ status: "starting", title: null, startedAt: null, createdAt: ago(4000) });
    expect(displayState(d)).toBe("starting");
    expect(uptimeLabel(d, now)).toBe("0:04");
    expect(statusLine(d, now)).toBe("research@v2");
    expect(displayTitle(d)).toBe("untitled");
  });

  it("meta line", () => {
    expect(metaLine(desktop({ template: "base", templateVersion: 1, session: "t3/onboarding-vendors", startedAt: ago(18 * M) }), now)).toBe(
      "base@v1 · t3/onboarding-vendors · 18m",
    );
    expect(metaLine(desktop({ session: null }), now)).toBe("research@v2 · 42m");
  });

  it("hardware markers: kvm and a non-default memory cap", () => {
    const G = 1024 ** 3;
    expect(hardwareMarks(desktop({ hardware: { memoryBytes: 2 * G, cpus: 1.5, kvm: false } }))).toEqual([]);
    expect(hardwareMarks(desktop({ hardware: { memoryBytes: 8 * G, cpus: 4, kvm: true } }))).toEqual(["kvm", "8g"]);
    expect(hardwareMarks(desktop({ hardware: { memoryBytes: 4 * G, cpus: 2, kvm: false } }), 4 * G)).toEqual([]);
    expect(hardwareMarks(desktop({ hardware: undefined }))).toEqual([]);
    expect(metaLine(desktop({ session: null, hardware: { memoryBytes: 1.5 * G, cpus: 2, kvm: true } }), now)).toBe("research@v2 · kvm · 1536m · 42m");
    expect(templateHardwareLabel({ kvm: true, memoryBytes: 8 * G, cpus: 4 })).toBe("kvm · 8g · 4 cpu");
    expect(templateHardwareLabel({ kvm: false, memoryBytes: null, cpus: null })).toBe("");
    expect(templateHardwareLabel(null)).toBe("");
  });
});

describe("filters on the prototype fixture", () => {
  const list = [...createState().desktops.values()].map(publicDesktop);

  it("counts tabs like the prototype: all 8 · attention 2 · running 4 · stopped 1", () => {
    expect(tabCounts(list)).toEqual({ all: 8, attention: 2, running: 4, stopped: 1 });
  });

  it("filters by query across title, session, template and last action", () => {
    expect(filterDesktops(list, "all", "review").map((d) => d.title)).toEqual(["pr-review-212"]);
    expect(filterDesktops(list, "all", "onboarding").map((d) => d.title)).toEqual(["supplier-portal-sign-up"]);
    expect(filterDesktops(list, "all", "office@v4").map((d) => d.title)).toEqual(["invoice-export.sub2"]);
    expect(filterDesktops(list, "all", "ui_tree").map((d) => d.title)).toEqual(["move-release-assets"]);
    expect(filterDesktops(list, "running", "research").map((d) => d.title)).toEqual(["linear-triage", "pr-review-212"]);
    expect(tabCounts(list, "research")).toEqual({ all: 4, attention: 0, running: 2, stopped: 1 });
    expect(matchesQuery(list[0]!, "  ")).toBe(true);
  });

  it("sorts like the prototype: needs-you first, active by creation, then stopped, then starting", () => {
    expect(sortDesktops(list).map((d) => d.title ?? "untitled")).toEqual([
      "supplier-portal-sign-up",
      "linear-triage",
      "invoice-export.sub2",
      "pr-review-212",
      "drag-test-suite",
      "move-release-assets",
      "docs-screenshots",
      "untitled",
    ]);
  });

  it("attention list excludes desktops already under control", () => {
    expect(attentionList(list).map((d) => d.title)).toEqual(["supplier-portal-sign-up"]);
    const taken = list.map((d) => (d.id === "7f3a" ? { ...d, lock: { holder: "dashboard", since: ago(0), generation: 2 } } : d));
    expect(attentionList(taken)).toEqual([]);
  });
});
