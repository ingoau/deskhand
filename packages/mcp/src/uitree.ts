/**
 * Compact, model-friendly rendering of the daemon's /ui-tree JSON for the `ui_tree` tool.
 *
 * One line per element, indented by nesting:
 *   button "Save" [disabled] @87,63 box=[71,48,32,31]
 * - `@x,y` is the point to click, in screenshot pixels: the centre of the part of the element that is on
 *   screen, inside its window and not covered by a window above it (windows come topmost first). If no
 *   part is visible the line says why instead (covered / outside the visible area).
 * - Unnamed layout wrappers (panels, fillers, scroll panes…) are left out and their children shown in
 *   their place; toolbars, menus, lists and documents stay as headings.
 * - The output is capped (default 24 000 characters); when cut it says so and how to narrow it down.
 */
import type { UiNodeT } from "@deskhand/shared";

export interface UiTreeNode extends UiNodeT {
  description?: string;
  value?: string;
  z?: number;
  children?: UiTreeNode[];
}

export interface UiTreeRoot {
  role?: string;
  children?: UiTreeNode[];
  truncated?: boolean;
  /** Every window (also those a `window` filter left out), topmost first: name, app, box, states, z. */
  stack?: Array<{ name: string; app?: string; box?: [number, number, number, number]; states?: string[]; z: number }>;
}

type Rect = [number, number, number, number]; // x, y, w, h

/** Unnamed nodes of these roles are layout only: their children are shown in their place. */
const WRAPPERS = new Set([
  "filler", "panel", "section", "unknown", "grouping", "layered pane", "split pane", "scroll pane", "viewport",
  "redundant object", "invalid", "static", "list item", "table cell", "paragraph", "form", "article", "block quote",
  "div", "landmark", "internal frame", "embedded", "page tab", "glass pane", "root pane", "option pane", "canvas",
  "image map", "header", "footer", "description list", "description term", "description value", "label", "text",
]);
/** Containers worth a heading line even without a name. */
const HEADINGS = new Set([
  "menu bar", "tool bar", "status bar", "page tab list", "document web", "document frame", "table", "tree", "tree table",
  "list", "list box", "menu", "popup menu", "dialog", "alert", "notification", "tab list",
]);

function inter(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

function inside(p: [number, number], r: Rect): boolean {
  return p[0] >= r[0] && p[0] < r[0] + r[2] && p[1] >= r[1] && p[1] < r[1] + r[3];
}

function q(s: string, n = 120): string {
  const one = s.replace(/\s+/g, " ").trim();
  return JSON.stringify(one.length > n ? one.slice(0, n) + "…" : one);
}

interface Cover {
  rect: Rect;
  title: string;
}

/** The point to click inside `box` (clipped to `clip`), avoiding `covers`; or why there is none. */
export function clickPoint(box: Rect, clip: Rect, covers: Cover[]): { at: [number, number] } | { why: string } {
  const vis = inter(box, clip);
  if (!vis) return { why: "outside the visible area; scroll or move the window first" };
  const free = (p: [number, number]) => !covers.some((c) => inside(p, c.rect));
  const centre: [number, number] = [Math.floor(vis[0] + vis[2] / 2), Math.floor(vis[1] + vis[3] / 2)];
  if (free(centre)) return { at: centre };
  // Look for another uncovered spot, nearest the centre first.
  const pts: Array<[number, number]> = [];
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      pts.push([Math.floor(vis[0] + ((i + 0.5) * vis[2]) / (steps + 1)), Math.floor(vis[1] + ((j + 0.5) * vis[3]) / (steps + 1))]);
    }
  }
  pts.sort((a, b) => Math.hypot(a[0] - centre[0], a[1] - centre[1]) - Math.hypot(b[0] - centre[0], b[1] - centre[1]));
  const p = pts.find(free);
  if (p) return { at: p };
  const by = covers.find((c) => inside(centre, c.rect));
  return { why: `covered by window ${q(by?.title ?? "?", 60)}; raise this window first` };
}

export interface FormatOptions {
  screen: { width: number; height: number };
  maxChars?: number;
  /** The `window` filter the agent passed (for messages). */
  window?: string;
}

export interface Formatted {
  text: string;
  truncated: boolean;
  windows: number;
  elements: number;
}

function isTrivialText(n: UiTreeNode): boolean {
  // Bullets and punctuation from web pages.
  return (
    (n.role === "static" || n.role === "text") &&
    !n.children?.length &&
    !/[\p{L}\p{N}]/u.test(n.name) &&
    !n.description &&
    n.value === undefined &&
    !n.states?.includes("editable")
  );
}

export function formatUiTree(tree: UiTreeRoot, opts: FormatOptions): Formatted {
  const maxChars = opts.maxChars ?? 24_000;
  const screen: Rect = [0, 0, opts.screen.width, opts.screen.height];
  const wins = [...(tree.children ?? [])].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const lines: string[] = [];
  let size = 0;
  let cut = false;
  let elements = 0;
  const cutWindows = new Set<string>();

  const push = (s: string, win: string): boolean => {
    if (cut) return false;
    if (size + s.length + 1 > maxChars) {
      cut = true;
      cutWindows.add(win);
      return false;
    }
    lines.push(s);
    size += s.length + 1;
    return true;
  };

  const states = (n: UiTreeNode, drop: string[] = []) => {
    const s = (n.states ?? []).filter((x) => !drop.includes(x));
    return s.length ? ` [${s.join(", ")}]` : "";
  };

  const covers: Cover[] = [];
  for (const w of wins) {
    const title = w.name || `(${w.app ?? "untitled"} window)`;
    const minimized = w.states?.includes("minimized");
    const wbox = w.box as Rect | undefined;
    const head = `window ${q(title, 100)} app=${q(w.app ?? "", 40)}${states(w)}${wbox ? ` box=[${wbox.join(",")}]` : ""}`;
    push(head, title);
    if (!minimized) {
      const clip = wbox ? (inter(wbox, screen) ?? screen) : screen;
      // Windows above this one, including ones a `window` filter left out (older helpers: only listed ones).
      const winCovers = tree.stack
        ? tree.stack
            .filter((s) => s.z < (w.z ?? 0) && s.box && !s.states?.includes("minimized"))
            .map((s) => ({ rect: s.box as Rect, title: s.name || `(${s.app ?? "untitled"} window)` }))
        : [...covers];
      const walk = (n: UiTreeNode, depth: number) => {
        if (cut) return;
        const named = !!(n.name || n.description || n.value !== undefined);
        const kids = (n.children ?? []).filter((c) => !isTrivialText(c));
        const hoist = !named && !n.states?.some((s) => s !== "selected") && (WRAPPERS.has(n.role) || (!HEADINGS.has(n.role) && !n.box));
        if (hoist) {
          for (const c of kids) walk(c, depth);
          return;
        }
        const pad = "  ".repeat(depth);
        let line = `${pad}${n.role}`;
        if (n.name) line += ` ${q(n.name)}`;
        else if (n.description) line += ` desc=${q(n.description, 80)}`;
        line += states(n);
        if (n.value !== undefined && (n.value === "" || n.value !== n.name)) line += ` value=${q(n.value, 160)}`;
        const box = n.box as Rect | undefined;
        const heading = HEADINGS.has(n.role) && !n.name && kids.length > 0;
        if (box && !heading) {
          const cp = clickPoint(box, clip, winCovers);
          line += "at" in cp ? ` @${cp.at[0]},${cp.at[1]} box=[${box.join(",")}]` : ` box=[${box.join(",")}] (${cp.why})`;
        }
        if (!push(line, title)) return;
        elements++;
        for (const c of kids) walk(c, depth + 1);
      };
      for (const c of w.children ?? []) walk(c, 1);
    }
    if (wbox && !minimized) covers.push({ rect: wbox, title });
  }

  const n = wins.length;
  const all = tree.stack ? tree.stack.map((s) => `${q(s.name || "(untitled)", 50)} (${s.app ?? "?"})`) : null;
  const header = [
    n
      ? `${n} window${n === 1 ? "" : "s"}${opts.window ? ` matching ${q(opts.window, 60)}` : ""}, topmost first. Each element: role "name" [states] value=… @x,y (the point to click, in screenshot pixels) box=[x,y,w,h].`
      : opts.window
        ? `No window matches ${q(opts.window, 60)} (by title or app name).${all ? (all.length ? ` Open windows: ${all.join(", ")}.` : " No windows with accessible elements are open.") : ""}`
        : "No windows with accessible elements are open.",
  ];
  if (n && opts.window && all && all.length > n) header.push(`(Other open windows: ${tree.stack!.filter((s) => !wins.some((w) => w.z === s.z)).map((s) => q(s.name || "(untitled)", 50)).join(", ")}.)`);
  const footer: string[] = [];
  if (cut || tree.truncated) {
    const names = tree.stack ? tree.stack.map((s) => s.name || s.app || "?") : wins.map((w) => w.name || w.app || "?");
    footer.push(
      `(Truncated: the tree is larger than ${cut ? `${maxChars} characters` : "the helper's node limit"}${cutWindows.size ? `; cut inside ${[...cutWindows].map((t) => q(t, 60)).join(", ")}` : ""}. Pass window="<part of a title or app name>" to see one window: ${names.map((t) => q(t, 50)).join(", ")}. For web pages, browser_snapshot is more precise.)`,
    );
  }
  return { text: [...header, ...lines, ...footer].join("\n"), truncated: cut || !!tree.truncated, windows: n, elements };
}
