/**
 * Key names → X keysyms. Accepts xdotool-style names ("ctrl+l", "Return", "alt+Tab", "super",
 * "ctrl+shift+t", "KP_Enter", "F5") plus the browser/Claude spellings agents often use
 * ("Enter", "Backspace", "ArrowDown", "PageDown", "cmd", "esc"). Pure: no X connection needed.
 */
import { DeskhandError } from "@deskhand/shared";
import keysymTable from "x11/lib/keysyms.js";

const KEYSYMS = keysymTable as Record<string, { code: number; description?: string }>;

/** Keysym name (without XK_) → code, e.g. "Return" → 0xff0d. */
const byName = new Map<string, number>();
/** Lower-cased name → code for case-insensitive fallback (first wins). */
const byLowerName = new Map<string, number>();
for (const [k, v] of Object.entries(KEYSYMS)) {
  if (!k.startsWith("XK_") || typeof v?.code !== "number") continue;
  const name = k.slice(3);
  if (!byName.has(name)) byName.set(name, v.code);
  const lower = name.toLowerCase();
  if (!byLowerName.has(lower)) byLowerName.set(lower, v.code);
}

export const XK = {
  Shift_L: 0xffe1,
  Control_L: 0xffe3,
  Alt_L: 0xffe9,
  Super_L: 0xffeb,
  Meta_L: 0xffe7,
  Return: 0xff0d,
  Tab: 0xff09,
  BackSpace: 0xff08,
  Escape: 0xff1b,
} as const;

const MODIFIERS: Record<string, number> = {
  shift: XK.Shift_L,
  ctrl: XK.Control_L,
  control: XK.Control_L,
  ctl: XK.Control_L,
  alt: XK.Alt_L,
  option: XK.Alt_L,
  opt: XK.Alt_L,
  super: XK.Super_L,
  win: XK.Super_L,
  windows: XK.Super_L,
  cmd: XK.Super_L,
  command: XK.Super_L,
  meta: XK.Super_L,
};

/** Aliases (lower-case) → keysym name. */
const ALIASES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  ret: "Return",
  esc: "Escape",
  escape: "Escape",
  backspace: "BackSpace",
  bksp: "BackSpace",
  del: "Delete",
  delete: "Delete",
  ins: "Insert",
  insert: "Insert",
  tab: "Tab",
  space: "space",
  spacebar: "space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  home: "Home",
  end: "End",
  pageup: "Prior",
  page_up: "Prior",
  pgup: "Prior",
  prior: "Prior",
  pagedown: "Next",
  page_down: "Next",
  pgdn: "Next",
  next: "Next",
  capslock: "Caps_Lock",
  caps_lock: "Caps_Lock",
  numlock: "Num_Lock",
  scrolllock: "Scroll_Lock",
  printscreen: "Print",
  print: "Print",
  prtsc: "Print",
  menu: "Menu",
  contextmenu: "Menu",
  pause: "Pause",
  break: "Break",
  plus: "plus",
  minus: "minus",
  equal: "equal",
  equals: "equal",
  comma: "comma",
  period: "period",
  dot: "period",
  slash: "slash",
  backslash: "backslash",
  semicolon: "semicolon",
  apostrophe: "apostrophe",
  quote: "apostrophe",
  grave: "grave",
  backtick: "grave",
  bracketleft: "bracketleft",
  bracketright: "bracketright",
  underscore: "underscore",
  // Modifiers pressed on their own ("super" opens a launcher on many desktops).
  shift: "Shift_L",
  ctrl: "Control_L",
  control: "Control_L",
  alt: "Alt_L",
  super: "Super_L",
  win: "Super_L",
  cmd: "Super_L",
  command: "Super_L",
  meta: "Super_L",
  option: "Alt_L",
};

/** Keysym for one character typed as text (Latin-1 maps directly, everything else via Unicode keysyms). */
export function charToKeysym(ch: string): number {
  if (ch === "\n" || ch === "\r") return XK.Return;
  if (ch === "\t") return XK.Tab;
  const cp = ch.codePointAt(0)!;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 | cp;
}

/** Resolve one key name (no "+") to a keysym. Throws invalid_argument for unknown names. */
export function keyNameToKeysym(name: string): number {
  if (name.length === 0) throw new DeskhandError("invalid_argument", "Empty key name.");
  // A single character: its own keysym ("a", "A", "1", "/", "é", "日").
  if ([...name].length === 1) return charToKeysym(name);
  const exact = byName.get(name);
  if (exact !== undefined) return exact;
  const lower = name.toLowerCase();
  const alias = ALIASES[lower];
  if (alias) return byName.get(alias)!;
  // F1..F35 in any case
  const f = /^f(\d{1,2})$/.exec(lower);
  if (f) {
    const n = Number(f[1]);
    if (n >= 1 && n <= 35) return 0xffbe + (n - 1);
  }
  const ci = byLowerName.get(lower);
  if (ci !== undefined) return ci;
  // Raw keysym in hex: "0xff0d"
  if (/^0x[0-9a-f]+$/i.test(name)) return parseInt(name, 16);
  throw new DeskhandError(
    "invalid_argument",
    `Unknown key name "${name}". Use xdotool-style names such as "Return", "Escape", "BackSpace", "Tab", "Up", "Page_Down", "F5", "ctrl+l", "alt+Tab".`,
  );
}

export interface KeyCombo {
  /** Modifier keysyms, pressed first and released last. */
  modifiers: number[];
  /** The main key; null when the combo is only modifiers ("ctrl+shift"). */
  key: number | null;
  /** Original text, for logs. */
  text: string;
}

/** Split "ctrl+shift++" style text into parts, keeping a literal "+" key. */
function splitPlus(combo: string): string[] {
  if (combo === "+") return ["+"];
  if (combo.endsWith("++")) return [...splitPlus(combo.slice(0, -2)), "+"];
  const parts = combo.split("+");
  if (parts.some((p) => p.length === 0)) {
    throw new DeskhandError("invalid_argument", `Malformed key combination "${combo}"; join keys with "+", e.g. "ctrl+shift+t".`);
  }
  return parts;
}

/**
 * Parse key text into one or more combos. Whitespace separates combos, like `xdotool key`:
 * "ctrl+a Delete" → [ctrl+a, Delete]. A combo is modifiers joined by "+" then one key.
 */
export function parseKeyText(text: string): KeyCombo[] {
  const trimmed = text.trim();
  if (!trimmed) throw new DeskhandError("invalid_argument", "The key text is empty; pass a key such as \"Return\" or \"ctrl+s\".");
  const combos: KeyCombo[] = [];
  for (const chunk of trimmed.split(/\s+/)) {
    const parts = splitPlus(chunk);
    const modifiers: number[] = [];
    let key: number | null = null;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const mod = MODIFIERS[p.toLowerCase()];
      if (!last) {
        if (mod === undefined) {
          throw new DeskhandError("invalid_argument", `"${p}" in "${chunk}" is not a modifier; use shift, ctrl, alt or super before the key.`);
        }
        modifiers.push(mod);
      } else if (mod !== undefined && parts.length > 1) {
        // "ctrl+shift": only modifiers
        modifiers.push(mod);
      } else {
        key = keyNameToKeysym(p);
      }
    });
    combos.push({ modifiers, key, text: chunk });
  }
  return combos;
}

/** Modifiers held during clicks/drags/scrolls: "ctrl+shift" → [Control_L, Shift_L]. */
export function parseModifiers(text: string | undefined): number[] {
  if (!text || !text.trim()) return [];
  const out: number[] = [];
  for (const raw of text.split("+")) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    const mod = MODIFIERS[p];
    if (mod === undefined) {
      throw new DeskhandError("invalid_argument", `"${raw}" is not a modifier; use shift, ctrl, alt or super joined with "+".`);
    }
    if (!out.includes(mod)) out.push(mod);
  }
  return out;
}

/** Human name of a keysym for logs/notes. */
export function keysymName(sym: number): string {
  for (const [name, code] of byName) if (code === sym) return name;
  if (sym >= 0x01000000) return `U+${(sym & 0xffffff).toString(16).toUpperCase().padStart(4, "0")}`;
  return `0x${sym.toString(16)}`;
}
