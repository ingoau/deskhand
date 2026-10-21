/** Human-readable summaries and screenshot overlays for action-log entries, computed from tool args. */
import type { Coordinate, Overlay } from "@deskhand/shared";

type Args = Record<string, unknown>;

function coord(v: unknown): Coordinate | undefined {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number") ? [v[0] as number, v[1] as number] : undefined;
}

function fmt(c: Coordinate | undefined): string {
  return c ? `[${c[0]}, ${c[1]}]` : "at cursor";
}

function short(s: unknown, n = 60): string {
  const str = String(s ?? "");
  const one = str.replace(/\s+/g, " ");
  return JSON.stringify(one.length > n ? one.slice(0, n) + "…" : one);
}

export function summarize(tool: string, args: Args = {}): string {
  const mods = args.text && tool !== "type" && tool !== "key" && tool !== "hold_key" ? ` +${String(args.text)}` : "";
  switch (tool) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click":
      return `${tool} ${fmt(coord(args.coordinate))}${mods}`;
    case "mouse_move":
      return `mouse_move ${fmt(coord(args.coordinate))}`;
    case "left_click_drag":
      return `left_click_drag ${fmt(coord(args.start_coordinate))} → ${fmt(coord(args.coordinate))}${mods}`;
    case "scroll":
      return `scroll ${String(args.scroll_direction)} ${String(args.scroll_amount)} ${fmt(coord(args.coordinate))}${mods}`;
    case "type":
      return `type ${short(args.text)}`;
    case "key":
      return `key ${String(args.text)}${args.repeat && args.repeat !== 1 ? ` ×${String(args.repeat)}` : ""}`;
    case "hold_key":
      return `hold_key ${String(args.text)} ${String(args.duration)}s`;
    case "wait":
      return `wait ${String(args.duration)}s`;
    case "zoom": {
      const r = args.region as number[] | undefined;
      return `zoom [${(r ?? []).join(", ")}]`;
    }
    case "desktop_exec":
      return `desktop_exec ${short(args.command, 80)}`;
    case "ui_tree":
      return args.window ? `ui_tree ${short(args.window)}` : "ui_tree";
    case "set_title":
      return `set_title ${short(args.text)}`;
    case "request_human":
      return `request_human ${short(args.reason, 100)}`;
    case "file_put":
      return `file_put ${String(args.host_path)} → ${String(args.desktop_path)}`;
    case "file_get":
      return `file_get ${String(args.desktop_path)} → ${String(args.host_path)}`;
    case "template_save":
      return `template_save ${String(args.name)}`;
    case "template_feedback":
      return `template_feedback ${String(args.result)} ${short(args.note)}`;
    default:
      return tool;
  }
}

/** Marks to draw on the entry's screenshot: click points, drag paths, zoom regions. */
export function overlaysFor(tool: string, args: Args = {}, cursor?: Coordinate): Overlay[] {
  switch (tool) {
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const at = coord(args.coordinate) ?? cursor;
      return at ? [{ kind: "point", at, label: tool.replace("_click", "") }] : [];
    }
    case "mouse_move": {
      const at = coord(args.coordinate);
      return at ? [{ kind: "point", at, label: "move" }] : [];
    }
    case "left_mouse_down":
    case "left_mouse_up":
      return cursor ? [{ kind: "point", at: cursor, label: tool === "left_mouse_down" ? "down" : "up" }] : [];
    case "left_click_drag": {
      const a = coord(args.start_coordinate);
      const b = coord(args.coordinate);
      return a && b ? [{ kind: "path", points: [a, b] }] : [];
    }
    case "scroll": {
      const at = coord(args.coordinate) ?? cursor;
      return at ? [{ kind: "point", at, label: `scroll ${String(args.scroll_direction)}` }] : [];
    }
    case "zoom": {
      const r = args.region as number[] | undefined;
      return r && r.length === 4 ? [{ kind: "region", region: [r[0]!, r[1]!, r[2]!, r[3]!] }] : [];
    }
    default:
      return [];
  }
}
