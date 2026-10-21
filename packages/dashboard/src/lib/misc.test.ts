import { describe, expect, it } from "vitest";
import type { TemplateVersion } from "@deskhand/shared";
import { normalizeBase, pageUrl, url, wsUrl } from "./base";
import { charToKeysym, KEYSYM, textToKeysyms } from "./keysym";
import { diffList, diffVersions, isEmptyDiff, versionHistory } from "./templateDiff";

describe("base path", () => {
  it("normalises", () => {
    expect(normalizeBase(undefined)).toBe("/");
    expect(normalizeBase("")).toBe("/");
    expect(normalizeBase("/deskhand")).toBe("/deskhand/");
    expect(normalizeBase("deskhand/")).toBe("/deskhand/");
    expect(normalizeBase("https://host.ts.net/deskhand/")).toBe("/deskhand/");
    expect(normalizeBase("//a//b")).toBe("/a/b/");
  });
  it("builds URLs under the base", () => {
    expect(url("api/desktops", "/deskhand/")).toBe("/deskhand/api/desktops");
    expect(url("/api/desktops", "/")).toBe("/api/desktops");
    expect(wsUrl("api/desktops/x/vnc?mode=view", { protocol: "https:", host: "h.ts.net" }, "/deskhand/")).toBe("wss://h.ts.net/deskhand/api/desktops/x/vnc?mode=view");
    expect(wsUrl("api/x", { protocol: "http:", host: "127.0.0.1:7480" }, "/")).toBe("ws://127.0.0.1:7480/api/x");
    expect(pageUrl("desktops/7f3a", { origin: "https://h" }, "/deskhand/")).toBe("https://h/deskhand/desktops/7f3a");
  });
});

describe("keysyms", () => {
  it("maps Latin-1 directly and other characters to the Unicode range", () => {
    expect(charToKeysym("a")).toBe(0x61);
    expect(charToKeysym("7")).toBe(0x37);
    expect(charToKeysym("é")).toBe(0xe9);
    expect(charToKeysym("€")).toBe(0x010020ac);
    expect(charToKeysym("\n")).toBe(KEYSYM.Return);
    expect(charToKeysym("\t")).toBe(KEYSYM.Tab);
  });
  it("splits by code point", () => {
    expect(textToKeysyms("ab😀")).toEqual([0x61, 0x62, 0x01000000 + 0x1f600]);
    expect(textToKeysyms("a\r\nb")).toEqual([0x61, KEYSYM.Return, 0x62]);
  });
});

function v(n: number, p: Partial<TemplateVersion> = {}): TemplateVersion {
  return {
    version: n,
    image: `deskhand-template:x-v${n}`,
    createdAt: new Date(2026, 9, n).toISOString(),
    savedBy: "dashboard",
    byAgent: false,
    baseVersion: "0.1.0",
    hasRecipe: false,
    description: { summary: "s", use_when: "u" },
    loggedInSites: [],
    extensions: [],
    packages: [],
    sizeBytes: null,
    inUse: 0,
    ...p,
  };
}

describe("template version diff", () => {
  it("diffs lists", () => {
    expect(diffList(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
    expect(diffList([], [])).toEqual({ added: [], removed: [] });
  });

  it("reports description, sites, extensions, packages, base and recipe changes", () => {
    const d = diffVersions(
      v(1, { loggedInSites: ["github.com"], packages: ["gh"], description: { summary: "GitHub", use_when: "PRs", tags: ["github"] } }),
      v(2, {
        loggedInSites: ["github.com", "linear.app"],
        extensions: ["Refined GitHub"],
        packages: ["gh", "jq"],
        baseVersion: "0.2.0",
        hasRecipe: true,
        description: { summary: "GitHub and Linear", use_when: "PRs", setup_notes: "Triage view", tags: ["github", "linear"] },
      }),
    );
    expect(d.initial).toBe(false);
    expect(d.description).toEqual([
      { field: "summary", before: "GitHub", after: "GitHub and Linear" },
      { field: "setup_notes", before: "", after: "Triage view" },
      { field: "tags", before: "github", after: "github, linear" },
    ]);
    expect(d.loggedInSites).toEqual({ added: ["linear.app"], removed: [] });
    expect(d.extensions).toEqual({ added: ["Refined GitHub"], removed: [] });
    expect(d.packages).toEqual({ added: ["jq"], removed: [] });
    expect(d.baseChanged).toEqual({ before: "0.1.0", after: "0.2.0" });
    expect(d.recipeChanged).toEqual({ before: false, after: true });
    expect(isEmptyDiff(d)).toBe(false);
  });

  it("first version lists what it contains; identical versions are empty", () => {
    const first = diffVersions(undefined, v(1, { loggedInSites: ["b.com", "a.com"] }));
    expect(first.initial).toBe(true);
    expect(first.loggedInSites.added).toEqual(["a.com", "b.com"]);
    expect(isEmptyDiff(diffVersions(v(1), v(2)))).toBe(true);
  });

  it("history is newest first and each version is compared with the previous number", () => {
    const h = versionHistory([v(1), v(3, { packages: ["x"] }), v(2)]);
    expect(h.map((x) => x.version.version)).toEqual([3, 2, 1]);
    expect(h[0]!.diff.packages.added).toEqual(["x"]);
    expect(h[2]!.diff.initial).toBe(true);
  });

  it("prefers the manager's per-version changes (phase 4), compared with the previous kept version", () => {
    const changes = {
      from: 1,
      description: [{ field: "tags", before: ["a"], after: ["a", "b"] }],
      loggedInSites: { added: ["linear.app"], removed: [] },
      extensions: { added: [], removed: ["Old"] },
      packages: { added: [], removed: [] },
      recipeChanged: true,
      baseChanged: true,
    };
    const h = versionHistory([v(1, { hasRecipe: true }), v(3, { baseVersion: "0.2.0", hasRecipe: true, changes })]);
    const d = h[0]!.diff;
    expect(d.description).toEqual([{ field: "tags", before: "a", after: "a, b" }]);
    expect(d.loggedInSites.added).toEqual(["linear.app"]);
    expect(d.extensions.removed).toEqual(["Old"]);
    expect(d.baseChanged).toEqual({ before: "0.1.0", after: "0.2.0" });
    expect(d.recipeChanged).toEqual({ before: true, after: true }); // edited, shown as "changed"
  });
});
