/**
 * Mock desktop screenshots as SVG, in the style of the prototypes: a dark desktop with one app window
 * (title bar, coloured header band, light body with skeleton text). Each "kind" draws content whose
 * positions line up with the coordinates used in the mock action log, so overlays land on something.
 * Dev/test only — never part of the production bundle.
 */

export type SceneKind = "captcha" | "issues" | "sheet" | "diff" | "drag" | "files" | "docs" | "blank";

export interface Scene {
  kind: SceneKind;
  accent: string;
  /** Mouse cursor position, or null to hide. */
  cursor?: [number, number] | null;
  /** Extra highlight, e.g. the row a click selected. */
  step?: number;
}

export const SCREEN = { width: 1280, height: 800 };
const W = SCREEN.width;
const H = SCREEN.height;

// Window geometry (matches the prototype thumbnails' proportions).
const WX = 54;
const WY = 42;
const WW = W - 2 * WX;
const WH = H - WY - 64;
const BAR = 37;
const BAND = 96;
const BODY_Y = WY + BAR + BAND;
const BODY_X = WX;

const SKEL = "#c9cacd";
const SKEL_DIM = "#dcdde0";

function rect(x: number, y: number, w: number, h: number, fill: string, extra = "") {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`;
}

function skeletonLines(x: number, y: number, widths: number[], gap = 38, h = 12, fill = SKEL) {
  return widths.map((w, i) => rect(x, y + i * gap, w, h, fill, `rx="2"`)).join("");
}

function cursorSvg([x, y]: [number, number]) {
  return `<path d="M${x} ${y} l0 26 l7 -6 l5 11 l5 -2 l-5 -11 l9 0 z" fill="#fff" stroke="#111" stroke-width="2" stroke-linejoin="round"/>`;
}

function content(kind: SceneKind, accent: string, step = 0): string {
  const x0 = BODY_X + 74;
  switch (kind) {
    case "captcha": {
      // Sign-in page with an image CAPTCHA card centred around (640, 470).
      const cx = 470;
      const cy = 330;
      const cells: string[] = [];
      const shades = ["#9aa3ad", "#b4bcc5", "#8c96a1", "#a9b2bb", "#7f8a95", "#b0b8c0"];
      for (let r = 0; r < 2; r++)
        for (let c = 0; c < 3; c++) cells.push(rect(cx + 10 + c * 108, cy + 55 + r * 82, 104, 78, shades[r * 3 + c]!));
      return (
        skeletonLines(x0, BODY_Y + 40, [420, 300], 34, 12, SKEL_DIM) +
        rect(cx, cy, 340, 310, "#ffffff", `stroke="#d6d7da" stroke-width="2" rx="3"`) +
        skeletonLines(cx + 14, cy + 16, [300, 220], 16, 8) +
        cells.join("") +
        rect(cx + 14, cy + 236, 312, 12, SKEL_DIM, `rx="2"`) +
        rect(cx + 14, cy + 270, 312, 22, accent, `rx="2"`)
      );
    }
    case "issues": {
      // Issue list: rows 44px tall starting at BODY_Y + 20; row 4 spans y≈322–366 (click at 344).
      const rows: string[] = [];
      for (let i = 0; i < 12; i++) {
        const y = BODY_Y + 15 + i * 44;
        if (y + 44 > WY + WH) break;
        const sel = i === 3 + (step % 3);
        rows.push(rect(BODY_X + 1, y, WW - 2, 43, sel ? "#e6e8fb" : i % 2 ? "#f6f6f8" : "#eff0f2"));
        rows.push(`<circle cx="${x0}" cy="${y + 22}" r="7" fill="none" stroke="${i % 3 ? "#9aa0aa" : accent}" stroke-width="2"/>`);
        rows.push(rect(x0 + 24, y + 16, 160 + ((i * 97) % 260), 11, SKEL, `rx="2"`));
        rows.push(rect(BODY_X + WW - 260, y + 16, 70, 11, SKEL_DIM, `rx="2"`));
        rows.push(rect(BODY_X + WW - 150, y + 14, 90, 15, i % 4 ? "#d7d9de" : "#f3d9a6", `rx="7"`));
      }
      return rows.join("");
    }
    case "sheet": {
      const cells: string[] = [];
      const cols = [60, 220, 160, 140, 140, 180];
      for (let r = 0; r < 13; r++) {
        let x = BODY_X + 20;
        const y = BODY_Y + 16 + r * 40;
        if (y + 40 > WY + WH) break;
        for (let c = 0; c < cols.length; c++) {
          const w = cols[c]!;
          cells.push(rect(x, y, w, 39, r === 0 ? "#e3e5e8" : "#fafafa", `stroke="#d8dadd"`));
          if (r > 0 || c > 0) cells.push(rect(x + 10, y + 14, Math.min(w - 20, 30 + ((r * 31 + c * 17) % 90)), 10, r === 0 ? "#9a9da3" : SKEL, `rx="2"`));
          x += w;
        }
      }
      return cells.join("");
    }
    case "diff": {
      const lines: string[] = [];
      for (let i = 0; i < 26; i++) {
        const y = BODY_Y + 14 + i * 21;
        if (y + 20 > WY + WH) break;
        const kind = i % 7 === 2 || i % 7 === 3 ? "add" : i % 9 === 5 ? "del" : "ctx";
        const bg = kind === "add" ? "#e2f5e6" : kind === "del" ? "#fbe4e4" : "#f7f7f8";
        lines.push(rect(BODY_X + 1, y, WW - 2, 20, bg));
        lines.push(rect(BODY_X + 14, y + 6, 26, 8, "#b9bcc2", `rx="2"`));
        lines.push(rect(BODY_X + 70 + (i % 4) * 24, y + 6, 120 + ((i * 73) % 420), 8, kind === "ctx" ? SKEL : kind === "add" ? "#8fcf9f" : "#e6a1a1", `rx="2"`));
      }
      return lines.join("");
    }
    case "drag": {
      // Source card at (150–280, 320–440), drop zone at (840–970, 350–470). Drag [212,380]→[904,410].
      const dropped = step % 2 === 1;
      return (
        skeletonLines(x0, BODY_Y + 30, [380, 260], 30, 12) +
        rect(840, 350, 130, 120, dropped ? "#fde7d3" : "#f7f7f8", `stroke="${accent}" stroke-width="3" stroke-dasharray="10 8" rx="6"`) +
        rect(dropped ? 840 : 150, dropped ? 350 : 320, 130, 120, accent, `rx="6" opacity="0.9"`) +
        rect(dropped ? 860 : 170, dropped ? 400 : 370, 90, 12, "#fff", `rx="2" opacity="0.8"`) +
        rect(420, 560, 420, 12, SKEL_DIM, `rx="2"`)
      );
    }
    case "files": {
      const items: string[] = [rect(BODY_X + 1, BODY_Y, 200, WY + WH - BODY_Y - 1, "#e6e7ea")];
      items.push(skeletonLines(BODY_X + 24, BODY_Y + 24, [120, 90, 140, 100, 110], 34, 10));
      for (let i = 0; i < 15; i++) {
        const x = BODY_X + 250 + (i % 5) * 180;
        const y = BODY_Y + 30 + Math.floor(i / 5) * 160;
        items.push(rect(x, y, 90, 70, i % 4 === 0 ? "#f0c869" : "#9bb4d6", `rx="6"`));
        items.push(rect(x - 10, y + 84, 110, 10, SKEL, `rx="2"`));
      }
      return items.join("");
    }
    case "docs":
      return (
        skeletonLines(x0, BODY_Y + 40, [520, 640, 600, 380], 30, 12) +
        rect(x0, BODY_Y + 180, 480, 260, "#d9dbe0", `rx="4"`) +
        rect(x0 + 520, BODY_Y + 180, 480, 260, "#d9dbe0", `rx="4"`) +
        skeletonLines(x0, BODY_Y + 470, [560, 610], 30, 12)
      );
    case "blank":
      return skeletonLines(x0, BODY_Y + 30, [610, 860, 760], 38);
  }
}

/** Full SVG document. `outW`/`outH` set the intrinsic size (thumbnails are smaller); the viewBox is the screen. */
export function sceneSvg(scene: Scene, outW = W, outH = H): string {
  const { kind, accent } = scene;
  const urlBar = kind === "captcha" || kind === "issues" || kind === "diff" || kind === "docs";
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${W} ${H}" font-family="monospace">`,
    rect(0, 0, W, H, "#26272b"),
    rect(WX, WY, WW, WH, "#eff0f2"),
    rect(WX, WY, WW, BAR, "#3b3c40"),
    `<circle cx="${WX + 20}" cy="${WY + BAR / 2}" r="5" fill="#5d5e63"/><circle cx="${WX + 38}" cy="${WY + BAR / 2}" r="5" fill="#5d5e63"/>`,
    urlBar ? rect(WX + 80, WY + 9, WW - 160, BAR - 18, "#55565b", `rx="9"`) : "",
    rect(WX, WY + BAR, WW, BAND, accent),
    urlBar ? rect(WX, WY + BAR, WW, 14, "#f4f4f6", `opacity="0.92"`) : "",
    rect(WX + 74, WY + BAR + 40, 180, 16, "rgba(255,255,255,0.55)", `rx="3"`),
    content(kind, accent, scene.step ?? 0),
    scene.cursor ? cursorSvg(scene.cursor) : "",
    `</svg>`,
  ];
  return parts.join("");
}

/** A dark "starting" frame. */
export function startingSvg(outW = 320, outH = 200): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${W} ${H}">${rect(0, 0, W, H, "#1c1d20")}</svg>`;
}

/** Cursor that wanders slowly so refreshing thumbnails visibly move in the demo. */
export function wanderingCursor(seed: number, t: number): [number, number] {
  const a = t / 2600 + seed;
  return [Math.round(640 + Math.cos(a) * 300 + Math.sin(a * 0.7) * 80), Math.round(440 + Math.sin(a * 1.3) * 160)];
}
