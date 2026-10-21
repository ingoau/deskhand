/** The mock must speak the shared contract, so the dashboard is built against real shapes. */
import { describe, expect, it } from "vitest";
import { ApiToken, DesktopSummary, LogEntry, SystemSummary, TemplateDetail, TemplateSummary } from "../../shared/src/index.ts";
import { createState, publicDesktop, systemSummary, templateSummary } from "./data.ts";
import { sceneSvg } from "./images.ts";

describe("mock data matches packages/shared schemas", () => {
  const s = createState();

  it("desktops", () => {
    const list = [...s.desktops.values()].map(publicDesktop);
    expect(list).toHaveLength(8);
    for (const d of list) expect(() => DesktopSummary.strict().parse(d)).not.toThrow();
  });

  it("system summary reproduces the prototype header", () => {
    const sys = SystemSummary.parse(systemSummary(s));
    expect(`${sys.running}/${sys.maxDesktops} · ${sys.cpuPercent}%`).toBe("6/8 · 46%");
  });

  it("log entries", () => {
    expect(s.log.length).toBeGreaterThan(30);
    LogEntry.array().parse(s.log);
    expect(s.log.some((e) => e.overlays.some((o) => o.kind === "path"))).toBe(true);
    expect(s.log.some((e) => e.overlays.some((o) => o.kind === "region"))).toBe(true);
    expect(s.log.some((e) => e.outcome === "error")).toBe(true);
    expect(new Set(s.log.map((e) => e.id)).size).toBe(s.log.length);
  });

  it("templates and tokens", () => {
    for (const t of s.templates.values()) {
      TemplateDetail.parse(t);
      TemplateSummary.strict().parse(templateSummary(t));
    }
    expect([...s.templates.values()].filter((t) => t.isDefault).map((t) => t.name)).toEqual(["base"]);
    ApiToken.array().parse(s.tokens.map((t) => t.token));
  });

  it("scene SVGs are well-formed-ish", () => {
    const svg = sceneSvg({ kind: "captcha", accent: "#2f6b52", cursor: [640, 470] }, 320, 200);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 1280 800"');
    expect(svg.endsWith("</svg>")).toBe(true);
  });
});
