import { describe, expect, it } from "vitest";
import { DeskhandError } from "@deskhand/shared";
import { charToKeysym, keyNameToKeysym, parseKeyText, parseModifiers, XK } from "../../src/keys.js";

describe("keyNameToKeysym", () => {
  it("resolves xdotool names exactly", () => {
    expect(keyNameToKeysym("Return")).toBe(0xff0d);
    expect(keyNameToKeysym("BackSpace")).toBe(0xff08);
    expect(keyNameToKeysym("KP_Enter")).toBe(0xff8d);
    expect(keyNameToKeysym("Page_Down")).toBe(0xff56);
    expect(keyNameToKeysym("Super_L")).toBe(0xffeb);
  });
  it("maps browser/Claude spellings", () => {
    expect(keyNameToKeysym("Enter")).toBe(0xff0d);
    expect(keyNameToKeysym("Backspace")).toBe(0xff08);
    expect(keyNameToKeysym("ArrowDown")).toBe(0xff54);
    expect(keyNameToKeysym("PageDown")).toBe(0xff56);
    expect(keyNameToKeysym("pageup")).toBe(0xff55);
    expect(keyNameToKeysym("esc")).toBe(0xff1b);
    expect(keyNameToKeysym("Delete")).toBe(0xffff);
    expect(keyNameToKeysym("space")).toBe(0x20);
    expect(keyNameToKeysym("super")).toBe(XK.Super_L);
    expect(keyNameToKeysym("cmd")).toBe(XK.Super_L);
  });
  it("handles function keys and single characters", () => {
    expect(keyNameToKeysym("F1")).toBe(0xffbe);
    expect(keyNameToKeysym("f12")).toBe(0xffc9);
    expect(keyNameToKeysym("a")).toBe(0x61);
    expect(keyNameToKeysym("A")).toBe(0x41);
    expect(keyNameToKeysym("/")).toBe(0x2f);
    expect(keyNameToKeysym("é")).toBe(0xe9);
    expect(keyNameToKeysym("日")).toBe(0x01000000 | 0x65e5);
  });
  it("is case-insensitive as a fallback", () => {
    expect(keyNameToKeysym("return")).toBe(0xff0d);
    expect(keyNameToKeysym("TAB")).toBe(0xff09);
    expect(keyNameToKeysym("escape")).toBe(0xff1b);
  });
  it("rejects unknown names with invalid_argument", () => {
    expect(() => keyNameToKeysym("NotAKey")).toThrow(DeskhandError);
    try {
      keyNameToKeysym("NotAKey");
    } catch (e) {
      expect((e as DeskhandError).code).toBe("invalid_argument");
    }
  });
});

describe("parseKeyText", () => {
  it("parses modifier combos", () => {
    const [c] = parseKeyText("ctrl+shift+t");
    expect(c!.modifiers).toEqual([XK.Control_L, XK.Shift_L]);
    expect(c!.key).toBe(0x74);
  });
  it("parses alt+Tab and ctrl+l", () => {
    expect(parseKeyText("alt+Tab")[0]).toMatchObject({ modifiers: [XK.Alt_L], key: XK.Tab });
    expect(parseKeyText("ctrl+l")[0]).toMatchObject({ modifiers: [XK.Control_L], key: 0x6c });
  });
  it("supports a lone modifier and modifier-only combos", () => {
    expect(parseKeyText("super")[0]).toMatchObject({ modifiers: [], key: XK.Super_L });
    expect(parseKeyText("ctrl+shift")[0]).toMatchObject({ modifiers: [XK.Control_L, XK.Shift_L], key: null });
  });
  it("supports the plus key", () => {
    expect(parseKeyText("ctrl++")[0]).toMatchObject({ modifiers: [XK.Control_L], key: 0x2b });
    expect(parseKeyText("+")[0]).toMatchObject({ modifiers: [], key: 0x2b });
    expect(parseKeyText("ctrl+plus")[0]).toMatchObject({ modifiers: [XK.Control_L], key: 0x2b });
  });
  it("splits whitespace-separated sequences like xdotool", () => {
    const combos = parseKeyText("ctrl+a Delete");
    expect(combos).toHaveLength(2);
    expect(combos[1]).toMatchObject({ modifiers: [], key: 0xffff });
  });
  it("rejects non-modifiers before the key and empty input", () => {
    expect(() => parseKeyText("a+b")).toThrow(/not a modifier/);
    expect(() => parseKeyText("  ")).toThrow(DeskhandError);
    expect(() => parseKeyText("ctrl+")).toThrow(DeskhandError);
  });
});

describe("parseModifiers", () => {
  it("parses click modifiers", () => {
    expect(parseModifiers("ctrl+shift")).toEqual([XK.Control_L, XK.Shift_L]);
    expect(parseModifiers("alt")).toEqual([XK.Alt_L]);
    expect(parseModifiers("super")).toEqual([XK.Super_L]);
    expect(parseModifiers(undefined)).toEqual([]);
    expect(parseModifiers("")).toEqual([]);
  });
  it("deduplicates and rejects non-modifiers", () => {
    expect(parseModifiers("ctrl+control")).toEqual([XK.Control_L]);
    expect(() => parseModifiers("ctrl+x")).toThrow(/not a modifier/);
  });
});

describe("charToKeysym", () => {
  it("maps control characters and Latin-1 directly", () => {
    expect(charToKeysym("\n")).toBe(XK.Return);
    expect(charToKeysym("\t")).toBe(XK.Tab);
    expect(charToKeysym("a")).toBe(0x61);
    expect(charToKeysym("~")).toBe(0x7e);
    expect(charToKeysym("ü")).toBe(0xfc);
  });
  it("uses Unicode keysyms beyond Latin-1, including astral characters", () => {
    expect(charToKeysym("€")).toBe(0x010020ac);
    expect(charToKeysym("😀")).toBe(0x01000000 | 0x1f600);
  });
});
