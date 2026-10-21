/** X11 keysyms for typing text into the live view from a phone keyboard. */
export const KEYSYM = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Control_L: 0xffe3,
  Alt_L: 0xffe9,
  Super_L: 0xffeb,
} as const;

/** Keysym for one character: Latin-1 maps directly, everything else uses the Unicode keysym range. */
export function charToKeysym(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp == null) throw new Error("empty character");
  if (cp === 0x0a || cp === 0x0d) return KEYSYM.Return;
  if (cp === 0x09) return KEYSYM.Tab;
  if (cp === 0x08) return KEYSYM.BackSpace;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 + cp;
}

/** Keysyms for a whole string, one per code point. */
export function textToKeysyms(text: string): number[] {
  return Array.from(text.replace(/\r\n/g, "\n"), charToKeysym);
}
