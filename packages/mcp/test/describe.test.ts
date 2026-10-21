import { describe, expect, it } from "vitest";
import { overlaysFor, summarize } from "../src/describe.js";
import { handbackNote } from "../src/registry.js";

describe("overlays computed from tool args", () => {
  it("click points use the coordinate, or the cursor when omitted", () => {
    expect(overlaysFor("left_click", { coordinate: [812, 344] })).toEqual([{ kind: "point", at: [812, 344], label: "left" }]);
    expect(overlaysFor("double_click", {}, [5, 6])).toEqual([{ kind: "point", at: [5, 6], label: "double" }]);
    expect(overlaysFor("right_click", {})).toEqual([]);
  });
  it("drags become paths, zooms become regions, scrolls and moves points", () => {
    expect(overlaysFor("left_click_drag", { start_coordinate: [1, 2], coordinate: [30, 40] })).toEqual([{ kind: "path", points: [[1, 2], [30, 40]] }]);
    expect(overlaysFor("zoom", { region: [0, 0, 100, 50] })).toEqual([{ kind: "region", region: [0, 0, 100, 50] }]);
    expect(overlaysFor("scroll", { scroll_direction: "down", scroll_amount: 3, coordinate: [7, 8] })).toEqual([{ kind: "point", at: [7, 8], label: "scroll down" }]);
    expect(overlaysFor("mouse_move", { coordinate: [9, 9] })).toEqual([{ kind: "point", at: [9, 9], label: "move" }]);
    expect(overlaysFor("left_mouse_down", {}, [3, 4])).toEqual([{ kind: "point", at: [3, 4], label: "down" }]);
    expect(overlaysFor("type", { text: "x" })).toEqual([]);
  });
});

describe("summaries", () => {
  it("are short and readable", () => {
    expect(summarize("left_click", { coordinate: [812, 344] })).toBe("left_click [812, 344]");
    expect(summarize("left_click", { coordinate: [1, 2], text: "ctrl" })).toBe("left_click [1, 2] +ctrl");
    expect(summarize("left_click_drag", { start_coordinate: [1, 2], coordinate: [3, 4] })).toBe("left_click_drag [1, 2] → [3, 4]");
    expect(summarize("key", { text: "ctrl+l", repeat: 3 })).toBe("key ctrl+l ×3");
    expect(summarize("type", { text: "a".repeat(100) })).toMatch(/^type "a{60}…"$/);
    expect(summarize("scroll", { scroll_direction: "up", scroll_amount: 2 })).toBe("scroll up 2 at cursor");
    expect(summarize("desktop_exec", { command: "ls -la" })).toBe('desktop_exec "ls -la"');
  });
});

describe("hand-back note", () => {
  const st = (hb: { note: string | null; generation: number } | null, generation: number) =>
    ({ generation, lock: null, lastHandback: hb ? { ...hb, at: "" } : null }) as never;
  it("quotes the user's note when the hand-back is newer than what the agent saw", () => {
    expect(handbackNote(st({ note: "logged in", generation: 3 }, 3), 1)).toBe("The user handed control back: logged in");
    expect(handbackNote(st({ note: null, generation: 3 }, 3), 1)).toContain("no note");
    expect(handbackNote(st({ note: "old", generation: 1 }, 3), 1)).toContain("Control of this desktop changed");
  });
});
