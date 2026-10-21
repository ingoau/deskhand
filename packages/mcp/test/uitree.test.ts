import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clickPoint, formatUiTree, type UiTreeRoot } from "../src/uitree.js";

/** Captured from a real desktop: Mousepad (GTK, active, topmost), FeatherPad (Qt) and Chromium, overlapping. */
const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures/uitree-three-apps.json"), "utf8")) as UiTreeRoot;
const screen = { width: 1280, height: 800 };

describe("formatUiTree", () => {
  const out = formatUiTree(fixture, { screen });
  const lines = out.text.split("\n");

  it("lists windows topmost first with the real active window", () => {
    const wins = lines.filter((l) => l.startsWith("window "));
    expect(wins).toHaveLength(3);
    expect(wins[0]).toMatch(/^window "\*~\/Documents\/notes.txt - Mousepad" app="mousepad" \[active\]/);
    expect(wins[1]).toMatch(/app="FeatherPad"/);
    expect(wins[1]).not.toContain("[active]");
    expect(wins[2]).toMatch(/app="Chromium"/);
    expect(out.windows).toBe(3);
  });

  it("gives named elements a click point and box", () => {
    expect(out.text).toMatch(/menu "File" @\d+,\d+ box=\[639,285,37,27\]/);
    expect(out.text).toMatch(/button "Save" \[disabled\] @87,63 box=\[71,48,32,31\]/);
    expect(out.text).toMatch(/entry "Address and search bar" \[editable\] value="\/opt\/deskhand\/testpages\/index.html"/);
  });

  it("uses descriptions for unnamed Qt buttons and reports editable values", () => {
    expect(out.text).toMatch(/button desc="Next \(F3\)" @\d+,\d+/);
    expect(out.text).toMatch(/text \[editable, focused\] value="" @\d+,\d+ box=\[640,315,638,447\]/);
  });

  it("moves click points off windows stacked above, or says the element is covered", () => {
    // Chromium's "Range slider" link sits under FeatherPad (x 1..701, y 22..522).
    const link = lines.find((l) => l.includes('link "Range slider"'))!;
    expect(link).toContain("covered by window");
    // Chromium's Bookmark button is not covered by FeatherPad but the address bar's centre (668,63) is:
    const entry = lines.find((l) => l.includes('entry "Address and search bar"'))!;
    const m = /@(\d+),(\d+)/.exec(entry)!;
    expect(Number(m[1])).toBeGreaterThan(701);
  });

  it("drops unnamed layout wrappers and duplicate text", () => {
    expect(out.text).not.toMatch(/^\s*filler/m);
    expect(out.text).not.toMatch(/^\s*panel/m);
    expect(out.text).not.toMatch(/static "•"/);
    expect(out.text).toMatch(/^\s+menu bar$/m);
  });

  it("is much smaller than the JSON", () => {
    expect(out.text.length).toBeLessThan(JSON.stringify(fixture).length * 0.8);
  });

  it("caps the size and says how to narrow it down", () => {
    const small = formatUiTree(fixture, { screen, maxChars: 1500 });
    expect(small.truncated).toBe(true);
    expect(small.text.length).toBeLessThan(2200);
    expect(small.text).toMatch(/Truncated: .*Pass window=/);
    expect(small.text).toContain('"deskhand drag test set - Chromium"');
  });

  it("reports an empty filter result", () => {
    expect(formatUiTree({ children: [] }, { screen, window: "nope" }).text).toMatch(/No window matches "nope"/);
  });

  it("with a window filter, still avoids windows stacked above that the filter left out", () => {
    const wins = fixture.children!;
    const stack = wins.map((w) => ({ name: w.name, app: w.app, box: w.box, states: w.states, z: w.z! }));
    const chromium = wins.find((w) => w.app === "Chromium")!;
    const out = formatUiTree({ children: [chromium], stack }, { screen, window: "chromium" });
    expect(out.windows).toBe(1);
    expect(out.text.split("\n").find((l) => l.includes('link "Range slider"'))).toContain("covered by window");
    expect(out.text).toContain("Other open windows:");
    const none = formatUiTree({ children: [], stack }, { screen, window: "gimp" });
    expect(none.text).toMatch(/No window matches "gimp".*Open windows: .*Mousepad/);
  });
});

describe("clickPoint", () => {
  const clip: [number, number, number, number] = [0, 0, 1280, 800];
  it("uses the centre of the visible part", () => {
    expect(clickPoint([100, 100, 50, 20], clip, [])).toEqual({ at: [125, 110] });
    expect(clickPoint([1200, 700, 200, 200], clip, [])).toEqual({ at: [1240, 750] });
  });
  it("reports elements outside the visible area", () => {
    expect(clickPoint([100, 900, 50, 20], clip, [])).toHaveProperty("why");
  });
  it("finds an uncovered spot or reports the cover", () => {
    const covers = [{ rect: [0, 0, 120, 800] as [number, number, number, number], title: "Other" }];
    const r = clickPoint([100, 100, 50, 20], clip, covers);
    expect("at" in r && r.at[0] >= 120).toBe(true);
    expect(clickPoint([10, 10, 50, 20], clip, covers)).toEqual({ why: 'covered by window "Other"; raise this window first' });
  });
});
