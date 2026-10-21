/**
 * deskhand's MCP tools. Computer-use names and parameters are copied from Anthropic's
 * computer_toolset_20260801 (see docs/design.md "Computer-use parity"); every tool also
 * takes an optional `desktop`.
 */
import { z } from "zod";
import { DeskhandError, type InputAction, type InputResponse, type TemplateSummary } from "@deskhand/shared";
import type { DesktopRef } from "./backend.js";
import { overlaysFor } from "./describe.js";
import { formatUiTree, type UiTreeRoot } from "./uitree.js";
import { text, type Content, type JsonSchema, type ToolContext, type ToolDef, type ToolOutput, type ToolRegistry } from "./registry.js";

// ---------------------------------------------------------------- schema pieces

const DESKTOP_DESC =
  "Which desktop: an id from desktop_start or desktop_list. Defaults to this session's first desktop (started automatically if there is none).";

const desktopProp = { type: "string", description: DESKTOP_DESC };
const coordinateProp = (description: string) => ({
  type: "array",
  items: { type: "integer", minimum: 0 },
  minItems: 2,
  maxItems: 2,
  description,
});
const modifiersProp = { type: "string", description: "modifier keys: shift, ctrl, alt, super, or a +-joined combination such as ctrl+shift" };

function obj(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

const zCoord = z.tuple([z.number().int().min(0), z.number().int().min(0)]);
const zDesktop = z.string().min(1).max(64).optional();
const zMods = z
  .string()
  .regex(/^\s*(shift|ctrl|control|alt|super|meta|cmd|win)(\s*\+\s*(shift|ctrl|control|alt|super|meta|cmd|win))*\s*$/i, "text holds modifier keys such as ctrl or ctrl+shift")
  .optional();

const SETTLE = " Returns the screen once it settles.";

// ---------------------------------------------------------------- helpers

function checkCoord(c: [number, number] | undefined, screen: { width: number; height: number }, name = "coordinate") {
  if (!c) return;
  if (c[0] >= screen.width || c[1] >= screen.height) {
    throw new DeskhandError("invalid_argument", `${name} [${c[0]}, ${c[1]}] is outside the ${screen.width}×${screen.height} screen.`);
  }
}

const LOCK_WAIT_MS = 30_000;
const SLACK_MS = 15_000;

function deadlineFor(input: InputAction): number {
  switch (input.action) {
    case "wait":
    case "hold_key":
      return Math.round(input.duration * 1000) + 10_000;
    case "type":
      return Math.min(300_000, 10_000 + input.text.length * 30);
    case "left_click_drag":
      return (input.duration_ms ?? 400) + (input.hold_ms ?? 150) + 10_000;
    case "key":
      return 10_000 + (input.repeat ?? 1) * 100;
    default:
      return 10_000;
  }
}

async function imageContent(ctx: ToolContext, raw: Buffer): Promise<Content> {
  const img = await ctx.backend.encodeForAgent(raw);
  return { type: "image", data: img.data, mimeType: img.mimeType };
}

/** Sends one input action and returns the settled screenshot. */
async function runInput(ctx: ToolContext, input: InputAction, line: (r: InputResponse) => string): Promise<ToolOutput> {
  const rd = ctx.desktop!;
  const deadline = deadlineFor(input);
  const res = await rd.daemon.input(
    { input, generation: ctx.generation, screenshot: true, format: "png", deadline_ms: deadline, actor: `mcp:${ctx.actor}` },
    LOCK_WAIT_MS + deadline + SLACK_MS,
    ctx.signal,
  );
  ctx.markSeen(res.generation);
  const content: Content[] = [];
  let raw: Buffer | null = null;
  const parts = [line(res)];
  if (res.unsettled) parts.push("The screen was still changing when this screenshot was taken.");
  for (const n of res.notes ?? []) parts.push(n);
  content.push(text(parts.join(" ")));
  if (res.screenshot) {
    raw = Buffer.from(res.screenshot.data, "base64");
    content.push(await imageContent(ctx, raw));
  }
  const args = input as unknown as Record<string, unknown>;
  return { content, overlays: overlaysFor(input.action, args, res.cursor), logScreenshot: raw, hasScreenshot: !!raw };
}

function describeDesktop(d: DesktopRef): Record<string, unknown> {
  return {
    id: d.id,
    title: d.title,
    template: `${d.template} v${d.templateVersion}`,
    status: d.status,
    persistent: d.persistent,
    default: d.sessionIndex === 0 ? true : undefined,
    screen: `${d.screen.width}x${d.screen.height}`,
    mounts: d.mounts.length ? d.mounts.map((m) => `${m.path}${m.write ? " (rw)" : " (ro)"}`) : undefined,
  };
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** One line per template for desktop_start's description (refreshed via tools/list_changed). */
export function templateLines(templates: TemplateSummary[]): string {
  if (!templates.length) return "";
  return templates
    .map((t) => {
      const flags = [
        t.loggedInSites.length ? `logged in: ${t.loggedInSites.slice(0, 6).join(", ")}${t.loggedInSites.length > 6 ? ", …" : ""}` : "",
        t.description.not_for ? `not for: ${clip(t.description.not_for, 100)}` : "",
        t.stale ? `stale: ${t.staleReason ?? "not confirmed recently"}` : "",
        t.outdatedBase ? "outdated base image" : "",
      ].filter(Boolean);
      const sum = clip(t.description.summary, 200).replace(/\.$/, "");
      return `- ${t.name}${t.isDefault ? " (default)" : ""}: ${sum}. Use when: ${clip(t.description.use_when, 200)}${flags.length ? ` [${flags.join("; ")}]` : ""}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------- registration

export function registerTools(reg: ToolRegistry, getTemplates: () => TemplateSummary[]): void {
  // ------------------------------------------------ lifecycle
  reg.register({
    name: "desktop_start",
    description: () => {
      let tpl = "";
      try {
        tpl = templateLines(getTemplates());
      } catch {
        tpl = "";
      }
      return [
        "Create a new isolated Linux desktop (1280×800) for this session, or reattach a persistent desktop by `name`, and return its id and first screenshot.",
        "Other desktop tools use this session's first desktop unless you pass `desktop`, and start one with defaults if none exists — call desktop_start first when you need mounts, a template or more than one desktop.",
        "Give each subagent its own desktop: start one per subagent and pass its id in the subagent's prompt so it passes `desktop` on every call.",
        "mounts: host directories (paths on the deskhand host) mounted at the same path, read-only unless write is true. persistent: keep the desktop when the session ends (only the user removes it).",
        "Templates (pass `template`): reuse a template that fits, update one that is close (start from it, adjust, template_save under the same name), and create a new one only when nothing fits. A template's logins are already active in a desktop started from it. Available now:",
        tpl || "- base: plain desktop",
        "template_info(name) shows a template's full description, manifest and history; after using one, report with template_feedback.",
      ].join("\n");
    },
    inputSchema: obj({
      mounts: {
        type: "array",
        description: "Host directories to mount at the same path inside the desktop.",
        items: obj({ path: { type: "string", description: "Absolute path on the deskhand host." }, write: { type: "boolean", description: "Mount read-write (default read-only)." } }, ["path"]),
      },
      template: { type: "string", description: "Template name (default: the default template). See template_list." },
      name: { type: "string", description: "A name shown in the dashboard; also reattaches an existing persistent desktop with that name." },
      persistent: { type: "boolean", description: "Keep this desktop after the session ends (default false)." },
    }),
    parse: z
      .object({
        mounts: z.array(z.object({ path: z.string().startsWith("/"), write: z.boolean().optional() }).strict()).max(20).optional(),
        template: z.string().min(1).max(64).optional(),
        name: z.string().min(1).max(200).optional(),
        persistent: z.boolean().optional(),
      })
      .strict(),
    scope: "session",
    async handler(args, ctx) {
      const rd = await ctx.backend.startDesktop(ctx.session, args);
      const st = await rd.daemon.state().catch(() => null);
      if (st) ctx.state.seen.set(rd.desktop.id, st.generation);
      const shot = await rd.daemon.screenshot({ format: "png" });
      const raw = Buffer.from(shot.data, "base64");
      const all = await ctx.backend.listDesktops(ctx.session);
      const d = rd.desktop;
      const lines = [
        ...rd.notes,
        `Desktop ${d.id} is ready (template ${d.template} v${d.templateVersion}, ${d.screen.width}×${d.screen.height}${d.persistent ? ", persistent" : ""}).`,
        all.length > 1 ? `This session now has ${all.length} desktops; pass desktop="${d.id}" to use this one.` : `Other tools use it by default; pass desktop="${d.id}" to be explicit.`,
      ];
      if (d.mounts.length) lines.push(`Mounted: ${d.mounts.map((m) => `${m.path} (${m.write ? "read-write" : "read-only"})`).join(", ")}.`);
      let tpl: TemplateSummary | undefined;
      try {
        tpl = d.template === "base" ? undefined : ctx.backend.listTemplates().find((x) => x.name === d.template);
      } catch {
        tpl = undefined;
      }
      if (tpl) {
        if (tpl.loggedInSites.length) {
          lines.push(
            `Template ${tpl.name} is already signed in to: ${tpl.loggedInSites.join(", ")}. Apps start closed: open Chromium (taskbar, or desktop_exec "chromium <url> &") and the session is active — no need to sign in.`,
          );
        }
        if (tpl.description.setup_notes) lines.push(`Template notes: ${clip(tpl.description.setup_notes, 500)}`);
        if (tpl.stale) lines.push(`This template is marked stale (${tpl.staleReason ?? "not confirmed recently"}); check that it still works and report with template_feedback.`);
        else lines.push("When you know whether the template worked as described, report it with template_feedback (ok or problem).");
      }
      return {
        content: [text(lines.join("\n")), await imageContent(ctx, raw)],
        desktopId: d.id,
        logScreenshot: raw,
        summary: `desktop_start ${d.template}${args.name ? ` "${args.name}"` : ""}`,
      };
    },
  });

  reg.register({
    name: "desktop_stop",
    description: "Remove a desktop when you are done with it (a persistent desktop is stopped instead and keeps its files). Defaults to this session's first desktop.",
    inputSchema: obj({ desktop: desktopProp }),
    parse: z.object({ desktop: zDesktop }).strict(),
    scope: "session",
    async handler(args, ctx) {
      const { desktop, action } = await ctx.backend.stopDesktop(ctx.session, args.desktop);
      ctx.state.seen.delete(desktop.id);
      return {
        content: [text(action === "removed" ? `Desktop ${desktop.id} was removed.` : `Persistent desktop ${desktop.id} was stopped; its files are kept.`)],
        desktopId: desktop.id,
      };
    },
  });

  reg.register({
    name: "desktop_list",
    description: "List this session's desktops with their ids, titles, templates and status.",
    inputSchema: obj({}),
    parse: z.object({}).strict(),
    scope: "session",
    async handler(_args, ctx) {
      const list = await ctx.backend.listDesktops(ctx.session);
      if (!list.length) return { content: [text("This session has no desktops yet. Call desktop_start (or any desktop tool) to start one.")] };
      return { content: [text(JSON.stringify(list.map(describeDesktop), null, 1))] };
    },
  });

  reg.register({
    name: "set_title",
    description: "Name a desktop in the deskhand dashboard, e.g. what you are doing on it.",
    inputSchema: obj({ text: { type: "string", description: "The title." }, desktop: desktopProp }, ["text"]),
    parse: z.object({ text: z.string().max(200), desktop: zDesktop }).strict(),
    scope: "session",
    async handler(args, ctx) {
      const d = await ctx.backend.setTitle(ctx.session, args.desktop, args.text);
      return { content: [text(`Desktop ${d.id} is now titled "${args.text}".`)], desktopId: d.id };
    },
  });

  // ------------------------------------------------ templates and help
  reg.register({
    name: "template_list",
    description: "List all templates with summary, use_when, logged-in sites, latest feedback and a stale marker.",
    inputSchema: obj({}),
    parse: z.object({}).strict(),
    scope: "session",
    async handler(_a, ctx) {
      const list = ctx.backend.listTemplates().map((t) => ({
        name: t.name,
        default: t.isDefault || undefined,
        version: t.currentVersion,
        summary: t.description.summary,
        use_when: t.description.use_when,
        not_for: t.description.not_for,
        tags: t.description.tags?.length ? t.description.tags : undefined,
        logged_in_sites: t.loggedInSites,
        extensions: t.extensions?.length ? t.extensions : undefined,
        latest_feedback: t.lastFeedback ? `${t.lastFeedback.kind} on v${t.lastFeedback.version}: ${t.lastFeedback.note} (${t.lastFeedback.at})` : null,
        last_confirmed_working: t.lastConfirmedAt,
        stale: t.stale ? (t.staleReason ?? true) : false,
        changed_by_agent_recently: t.recentlyChangedByAgent || undefined,
        outdated_base: t.outdatedBase || undefined,
        recipe: t.hasRecipe || undefined,
      }));
      return { content: [text(JSON.stringify(list, null, 1))] };
    },
  });

  reg.register({
    name: "template_info",
    description: "Full description, manifest and version history of one template.",
    inputSchema: obj({ name: { type: "string", description: "Template name." } }, ["name"]),
    parse: z.object({ name: z.string().min(1).max(64) }).strict(),
    scope: "session",
    async handler(args, ctx) {
      const t = ctx.backend.templateInfo(args.name);
      // Per-version recipes repeat the current one; keep the output compact.
      const versions = t.versions.map(({ recipe: _r, image: _i, ...v }) => v);
      return { content: [text(JSON.stringify({ ...t, versions }, null, 1))] };
    },
  });

  reg.register({
    name: "template_save",
    description: [
      "Save this desktop as a new version of a template so other agents can start from it (never overwrites: each save is a new version, and the user can roll back).",
      "Reuse rule: if a template already fits, use it instead of saving a new one; if one is close, start from it, adjust, and save under the same name; create a new name only when nothing fits.",
      "Before the snapshot deskhand closes the browser (cookies are flushed, so logins persist) and other apps, and clears caches, Downloads and /tmp; mounted host directories are never included. Every login in a template is usable by every agent that starts from it.",
      "A new template needs `description` (summary + use_when at least). Each new version must restate the description, or pass confirm_description: true to keep the previous one unchanged.",
      "deskhand records the logged-in sites, browser extensions and added packages automatically.",
    ].join("\n"),
    inputSchema: obj(
      {
        name: { type: "string", description: "Template name: lowercase letters, digits and dashes, e.g. github-bot." },
        description: obj(
          {
            summary: { type: "string", description: "What the template is, e.g. 'Chromium logged into GitHub as the bot account'." },
            use_when: { type: "string", description: "When an agent should pick it, e.g. 'Triaging issues or reviewing PRs in the GitHub web UI'." },
            not_for: { type: "string", description: "What it must not be used for." },
            setup_notes: { type: "string", description: "Anything the next agent should know (start pages, extensions, quirks)." },
            tags: { type: "array", items: { type: "string" } },
          },
          ["summary", "use_when"],
        ),
        confirm_description: { type: "boolean", description: "Keep the previous version's description unchanged (instead of passing description)." },
        recipe: {
          type: "string",
          description:
            "Optional bash setup script for everything scriptable (config files, extensions, packages), replayed on a fresh desktop when the base image updates; logins are carried over from the snapshot. Runs as the agent user like desktop_exec; start it with the line `# deskhand: run-as=root` to run as root (e.g. apt-get install). Omit to keep the previous version's recipe; pass an empty string to remove it.",
        },
        desktop: desktopProp,
      },
      ["name"],
    ),
    parse: z
      .object({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "use lowercase letters, digits and dashes"),
        description: z
          .object({
            summary: z.string().min(1).max(500),
            use_when: z.string().min(1).max(500),
            not_for: z.string().max(500).optional(),
            setup_notes: z.string().max(2000).optional(),
            tags: z.array(z.string().max(40)).max(20).optional(),
          })
          .strict()
          .optional(),
        confirm_description: z.boolean().optional(),
        recipe: z.string().max(100_000).optional(),
        desktop: zDesktop,
      })
      .strict(),
    scope: "desktop",
    async handler(args, ctx) {
      const t = await ctx.backend.saveTemplate(ctx.session, ctx.desktop!.desktop.id, args);
      const lines = [
        `Saved template ${t.name} v${t.currentVersion}. Other agents can now start from it with desktop_start(template="${t.name}").`,
        `Logged-in sites recorded: ${t.loggedInSites.length ? t.loggedInSites.join(", ") : "none"}.${t.extensions?.length ? ` Extensions: ${t.extensions.join(", ")}.` : ""}`,
        ...(t.notes ?? []),
      ];
      return { content: [text(lines.join("\n"))] };
    },
  });

  reg.register({
    name: "template_feedback",
    description: "Report whether the template this desktop started from worked (e.g. problem: 'Linear login expired'), so others know when it needs a refresh.",
    inputSchema: obj(
      {
        result: { type: "string", enum: ["ok", "problem"], description: "ok if the template worked as described, problem if not." },
        note: { type: "string", description: "What worked or what was wrong." },
        desktop: desktopProp,
      },
      ["result", "note"],
    ),
    parse: z.object({ result: z.enum(["ok", "problem"]), note: z.string().min(1).max(2000), desktop: zDesktop }).strict(),
    scope: "desktop",
    async handler(args, ctx) {
      const r = await ctx.backend.templateFeedback(ctx.session, ctx.desktop!.desktop.id, args.result, args.note);
      return { content: [text(`Recorded ${args.result} feedback for template ${r.template} v${r.version}. Thank you.`)] };
    },
  });

  reg.register({
    name: "request_human",
    description:
      "Ask the user to take over this desktop (for 2FA, a CAPTCHA, a login, or approval of something irreversible). Flags the desktop in the dashboard and waits until the user hands back (their note is returned with a fresh screenshot) or about 10 minutes pass, then returns 'still waiting' so you can call again.",
    inputSchema: obj({ reason: { type: "string", description: "What you need the user to do, in one or two sentences." }, desktop: desktopProp }, ["reason"]),
    parse: z.object({ reason: z.string().min(1).max(1000), desktop: zDesktop }).strict(),
    scope: "desktop",
    async handler(args, ctx) {
      const rd = ctx.desktop!;
      const r = await ctx.backend.requestHuman(ctx.session, rd.desktop.id, args.reason, {
        signal: ctx.signal,
        onProgress: (elapsed, total) => ctx.progress(Math.round(elapsed / 1000), Math.round(total / 1000), "Waiting for the user to hand the desktop back"),
      });
      if (r.outcome === "timeout") {
        return {
          content: [text("Still waiting: the user has not handed the desktop back yet. Call request_human again to keep waiting, or continue another way if you can.")],
          summary: "request_human (still waiting)",
        };
      }
      if (r.outcome === "stopped") return { content: [text("The desktop was stopped while waiting for the user.")], isError: true, error: { code: "desktop_stopped", message: "stopped while waiting" } };
      if (r.generation !== null) ctx.markSeen(r.generation);
      const shot = await rd.daemon.screenshot({ format: "png" });
      const raw = Buffer.from(shot.data, "base64");
      const msg =
        r.outcome === "dismissed"
          ? `The user dismissed the request without taking over${r.note ? `: ${r.note}` : "."}`
          : r.note && r.note.trim()
            ? `The user handed control back: ${r.note.trim()}`
            : "The user handed control back (no note).";
      return { content: [text(msg), await imageContent(ctx, raw)], logScreenshot: raw, hasScreenshot: true, summary: `request_human → ${r.outcome}` };
    },
  });

  reg.register({
    name: "file_put",
    description: "Copy a file from the deskhand host into the desktop. host_path is a path on the deskhand host and follows its mount rules.",
    inputSchema: obj(
      { host_path: { type: "string", description: "Absolute path of a file on the deskhand host." }, desktop_path: { type: "string", description: "Absolute destination path inside the desktop." }, desktop: desktopProp },
      ["host_path", "desktop_path"],
    ),
    parse: z.object({ host_path: z.string().startsWith("/"), desktop_path: z.string().startsWith("/"), desktop: zDesktop }).strict(),
    scope: "desktop",
    async handler(args, ctx) {
      const r = await ctx.backend.filePut(ctx.session, ctx.desktop!.desktop.id, args.host_path, args.desktop_path);
      return { content: [text(`Copied ${r.bytes} bytes from ${args.host_path} (host) to ${args.desktop_path} (desktop).`)] };
    },
  });

  reg.register({
    name: "file_get",
    description: "Copy a file out of the desktop to the deskhand host (e.g. a download from ~/Downloads). host_path follows the host's mount rules; its directory must exist.",
    inputSchema: obj(
      { desktop_path: { type: "string", description: "Absolute path of a file inside the desktop." }, host_path: { type: "string", description: "Absolute destination path on the deskhand host." }, desktop: desktopProp },
      ["desktop_path", "host_path"],
    ),
    parse: z.object({ desktop_path: z.string().startsWith("/"), host_path: z.string().startsWith("/"), desktop: zDesktop }).strict(),
    scope: "desktop",
    async handler(args, ctx) {
      const r = await ctx.backend.fileGet(ctx.session, ctx.desktop!.desktop.id, args.desktop_path, args.host_path);
      return { content: [text(`Copied ${r.bytes} bytes from ${args.desktop_path} (desktop) to ${args.host_path} (host).`)] };
    },
  });

  // ------------------------------------------------ computer use (computer_toolset_20260801)
  reg.register({
    name: "screenshot",
    description: "Take a screenshot of the whole screen. Coordinates in other tools are pixels of this image. To act precisely, prefer browser_snapshot for web pages and ui_tree for native apps; use zoom to read small text.",
    inputSchema: obj({ desktop: desktopProp }),
    parse: z.object({ desktop: zDesktop }).strict(),
    scope: "desktop",
    async handler(_a, ctx) {
      const shot = await ctx.desktop!.daemon.screenshot({ format: "png" });
      const raw = Buffer.from(shot.data, "base64");
      return { content: [await imageContent(ctx, raw)], logScreenshot: raw, hasScreenshot: true };
    },
  });

  reg.register({
    name: "zoom",
    description:
      "View a region of the screen at full resolution, scaled up to the usual screenshot size, to read small text or find tiny targets before clicking. region [x0, y0, x1, y1], the top-left and bottom-right corners. Coordinates in other tools stay in full-screenshot pixels.",
    inputSchema: obj(
      {
        region: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 4, maxItems: 4, description: "[x0, y0, x1, y1], the top-left and bottom-right corners." },
        desktop: desktopProp,
      },
      ["region"],
    ),
    parse: z
      .object({ region: z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)]), desktop: zDesktop })
      .strict()
      .refine((a) => a.region[2] > a.region[0] && a.region[3] > a.region[1], { message: "region needs x1 > x0 and y1 > y0", path: ["region"] }),
    scope: "desktop",
    async handler(args, ctx) {
      const s = ctx.desktop!.desktop.screen;
      const [x0, y0, x1, y1] = args.region;
      if (x1 > s.width || y1 > s.height) throw new DeskhandError("invalid_argument", `region [${args.region.join(", ")}] is outside the ${s.width}×${s.height} screen.`);
      const shot = await ctx.desktop!.daemon.screenshot({ format: "png", region: [x0, y0, x1, y1] });
      const raw = Buffer.from(shot.data, "base64");
      return {
        content: [text(`Zoomed region [${x0}, ${y0}, ${x1}, ${y1}] shown at ${shot.width}×${shot.height}.`), await imageContent(ctx, raw)],
        overlays: overlaysFor("zoom", args),
        logScreenshot: raw,
        hasScreenshot: true,
      };
    },
  });

  const clickDesc: Record<string, string> = {
    left_click: "Click the left mouse button at `coordinate`, or at the current cursor position when omitted. For web pages browser_click is more reliable; for native apps click the @x,y point from ui_tree; zoom before clicking small targets.",
    right_click: "Click the right mouse button at `coordinate`, or at the current cursor position when omitted.",
    middle_click: "Click the middle mouse button at `coordinate`, or at the current cursor position when omitted.",
    double_click: "Double-click the left mouse button at `coordinate`, or at the current cursor position when omitted.",
    triple_click: "Triple-click the left mouse button at `coordinate` (e.g. to select a line), or at the current cursor position when omitted.",
  };
  for (const action of ["left_click", "right_click", "middle_click", "double_click", "triple_click"] as const) {
    reg.register({
      name: action,
      description: clickDesc[action]! + " `text` holds modifier keys to hold during the click." + SETTLE,
      inputSchema: obj({ coordinate: coordinateProp("[x, y] in screenshot pixels."), text: modifiersProp, desktop: desktopProp }),
      parse: z.object({ coordinate: zCoord.optional(), text: zMods, desktop: zDesktop }).strict(),
      scope: "desktop",
      input: true,
      screenDependent: true,
      async handler(args, ctx) {
        checkCoord(args.coordinate, ctx.desktop!.desktop.screen);
        return runInput(ctx, { action, coordinate: args.coordinate, text: args.text }, (r) => `${action.replace("_", " ")} at [${r.cursor[0]}, ${r.cursor[1]}]${args.text ? ` with ${args.text}` : ""}.`);
      },
    });
  }

  reg.register({
    name: "left_click_drag",
    description:
      "Press the left mouse button at `start_coordinate`, drag to `coordinate` and release, moving in small eased steps so drag-and-drop, sliders and window moves register. `text` holds modifier keys. deskhand extras: duration_ms (default 400) and hold_ms (pause on the target before release, default 150)." +
      SETTLE,
    inputSchema: obj(
      {
        start_coordinate: coordinateProp("[x, y] where the drag starts."),
        coordinate: coordinateProp("[x, y] where the drag ends."),
        text: modifiersProp,
        duration_ms: { type: "integer", minimum: 0, maximum: 10000, description: "How long the move takes (default 400)." },
        hold_ms: { type: "integer", minimum: 0, maximum: 5000, description: "Pause on the target before releasing (default 150)." },
        desktop: desktopProp,
      },
      ["start_coordinate", "coordinate"],
    ),
    parse: z
      .object({
        start_coordinate: zCoord,
        coordinate: zCoord,
        text: zMods,
        duration_ms: z.number().int().min(0).max(10_000).optional(),
        hold_ms: z.number().int().min(0).max(5_000).optional(),
        desktop: zDesktop,
      })
      .strict(),
    scope: "desktop",
    input: true,
    screenDependent: true,
    async handler(args, ctx) {
      const s = ctx.desktop!.desktop.screen;
      checkCoord(args.start_coordinate, s, "start_coordinate");
      checkCoord(args.coordinate, s);
      const { desktop: _d, ...rest } = args;
      return runInput(ctx, { action: "left_click_drag", ...rest }, () => `Dragged from [${args.start_coordinate.join(", ")}] to [${args.coordinate.join(", ")}].`);
    },
  });

  reg.register({
    name: "left_mouse_down",
    description: "Press and hold the left mouse button at the current cursor position (use mouse_move to position it, left_mouse_up to release)." + SETTLE,
    inputSchema: obj({ desktop: desktopProp }),
    parse: z.object({ desktop: zDesktop }).strict(),
    scope: "desktop",
    input: true,
    screenDependent: true,
    async handler(_a, ctx) {
      return runInput(ctx, { action: "left_mouse_down" }, (r) => `Left button pressed at [${r.cursor.join(", ")}].`);
    },
  });

  reg.register({
    name: "left_mouse_up",
    description: "Release the left mouse button at the current cursor position." + SETTLE,
    inputSchema: obj({ desktop: desktopProp }),
    parse: z.object({ desktop: zDesktop }).strict(),
    scope: "desktop",
    input: true,
    screenDependent: true,
    async handler(_a, ctx) {
      return runInput(ctx, { action: "left_mouse_up" }, (r) => `Left button released at [${r.cursor.join(", ")}].`);
    },
  });

  reg.register({
    name: "mouse_move",
    description: "Move the mouse pointer to `coordinate` (to hover, or between left_mouse_down and left_mouse_up)." + SETTLE,
    inputSchema: obj({ coordinate: coordinateProp("[x, y] in screenshot pixels."), desktop: desktopProp }, ["coordinate"]),
    parse: z.object({ coordinate: zCoord, desktop: zDesktop }).strict(),
    scope: "desktop",
    input: true,
    screenDependent: true,
    async handler(args, ctx) {
      checkCoord(args.coordinate, ctx.desktop!.desktop.screen);
      return runInput(ctx, { action: "mouse_move", coordinate: args.coordinate }, (r) => `Pointer at [${r.cursor.join(", ")}].`);
    },
  });

  reg.register({
    name: "cursor_position",
    description: "Get the current mouse pointer position in screenshot pixels.",
    inputSchema: obj({ desktop: desktopProp }),
    parse: z.object({ desktop: zDesktop }).strict(),
    scope: "desktop",
    async handler(_a, ctx) {
      const [x, y] = await ctx.desktop!.daemon.cursor();
      return { content: [text(`X=${x}, Y=${y}`)] };
    },
  });

  reg.register({
    name: "scroll",
    description:
      "Scroll `scroll_amount` wheel clicks in `scroll_direction` (up, down, left, right) at `coordinate`, or at the current cursor position when omitted. `text` holds modifier keys (e.g. ctrl to zoom)." +
      SETTLE,
    inputSchema: obj(
      {
        scroll_direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Direction to scroll." },
        scroll_amount: { type: "integer", minimum: 0, maximum: 100, description: "Number of wheel clicks." },
        coordinate: coordinateProp("[x, y] to scroll at."),
        text: modifiersProp,
        desktop: desktopProp,
      },
      ["scroll_direction", "scroll_amount"],
    ),
    parse: z
      .object({
        scroll_direction: z.enum(["up", "down", "left", "right"]),
        scroll_amount: z.number().int().min(0).max(100),
        coordinate: zCoord.optional(),
        text: zMods,
        desktop: zDesktop,
      })
      .strict(),
    scope: "desktop",
    input: true,
    screenDependent: true,
    async handler(args, ctx) {
      checkCoord(args.coordinate, ctx.desktop!.desktop.screen);
      const { desktop: _d, ...rest } = args;
      return runInput(ctx, { action: "scroll", ...rest }, (r) => `Scrolled ${args.scroll_direction} ${args.scroll_amount} at [${r.cursor.join(", ")}].`);
    },
  });

  reg.register({
    name: "type",
    description: "Type a string of text at the keyboard focus." + SETTLE,
    inputSchema: obj({ text: { type: "string", description: "The text to type." }, desktop: desktopProp }, ["text"]),
    parse: z.object({ text: z.string().max(20_000), desktop: zDesktop }).strict(),
    scope: "desktop",
    input: true,
    screenDependent: true,
    async handler(args, ctx) {
      return runInput(ctx, { action: "type", text: args.text }, () => `Typed ${args.text.length} character${args.text.length === 1 ? "" : "s"}.`);
    },
  });

  reg.register({
    name: "key",
    description: "Press a key or key combination such as Return, ctrl+s or alt+Tab, `repeat` times (1–100, default 1)." + SETTLE,
    inputSchema: obj(
      {
        text: { type: "string", description: "Key or combination in xdotool syntax, e.g. Return, ctrl+l, alt+Tab, Page_Down." },
        repeat: { type: "integer", minimum: 1, maximum: 100, description: "How many times to press it (default 1)." },
        desktop: desktopProp,
      },
      ["text"],
    ),
    parse: z.object({ text: z.string().min(1).max(200), repeat: z.number().int().min(1).max(100).optional(), desktop: zDesktop }).strict(),
    scope: "desktop",
    input: true,
    screenDependent: true,
    async handler(args, ctx) {
      return runInput(ctx, { action: "key", text: args.text, repeat: args.repeat }, () => `Pressed ${args.text}${args.repeat && args.repeat > 1 ? ` ${args.repeat} times` : ""}.`);
    },
  });

  reg.register({
    name: "hold_key",
    description: "Hold down a key or key combination for `duration` seconds (up to 300), then release it." + SETTLE,
    inputSchema: obj(
      {
        text: { type: "string", description: "Key or combination to hold, e.g. shift or Right." },
        duration: { type: "number", minimum: 0, maximum: 300, description: "Seconds to hold it (up to 300)." },
        desktop: desktopProp,
      },
      ["text", "duration"],
    ),
    parse: z.object({ text: z.string().min(1).max(200), duration: z.number().min(0).max(300), desktop: zDesktop }).strict(),
    scope: "desktop",
    input: true,
    screenDependent: true,
    async handler(args, ctx) {
      return runInput(ctx, { action: "hold_key", text: args.text, duration: args.duration }, () => `Held ${args.text} for ${args.duration} s.`);
    },
  });

  reg.register({
    name: "wait",
    description: "Wait `duration` seconds (up to 300), then return a fresh screenshot.",
    inputSchema: obj({ duration: { type: "number", minimum: 0, maximum: 300, description: "Seconds to wait (up to 300)." }, desktop: desktopProp }, ["duration"]),
    parse: z.object({ duration: z.number().min(0).max(300), desktop: zDesktop }).strict(),
    scope: "desktop",
    input: true,
    async handler(args, ctx) {
      return runInput(ctx, { action: "wait", duration: args.duration }, () => `Waited ${args.duration} s.`);
    },
  });

  // ------------------------------------------------ beyond pixels
  reg.register({
    name: "desktop_exec",
    description:
      "Run a shell command inside the desktop as the `agent` user (stdin closed) and return its exit code and output: launch apps (`mousepad ~/notes.txt &`, `featherpad &`, `xdg-open file` — end with & so the call returns), read or set the clipboard (`xclip`), inspect files. Returns as soon as the command exits, even if it left background processes. timeout in seconds (default 60, max 600) kills the whole process group. Confined to the desktop container and its mounts.",
    inputSchema: obj(
      {
        command: { type: "string", description: "Shell command (run with bash -c in the agent user's home directory)." },
        timeout: { type: "number", minimum: 1, maximum: 600, description: "Seconds before the command is killed (default 60)." },
        desktop: desktopProp,
      },
      ["command"],
    ),
    parse: z.object({ command: z.string().min(1).max(100_000), timeout: z.number().min(1).max(600).optional(), desktop: zDesktop }).strict(),
    scope: "desktop",
    input: true,
    async handler(args, ctx) {
      const t = Math.round((args.timeout ?? 60) * 1000);
      const r = await ctx.desktop!.daemon.exec({ command: args.command, timeout_ms: t, generation: ctx.generation, actor: `mcp:${ctx.actor}` }, LOCK_WAIT_MS + t + SLACK_MS, ctx.signal);
      const cap = (s: string) => (s.length > 40_000 ? s.slice(0, 40_000) + `\n… (${s.length - 40_000} more characters truncated)` : s);
      const head = r.timedOut ? `Timed out after ${args.timeout ?? 60} s and was killed.` : r.signal ? `Killed by ${r.signal}.` : `Exit code ${r.exitCode}.`;
      const parts = [head];
      if (r.stdout) parts.push(`stdout:\n${cap(r.stdout)}`);
      if (r.stderr) parts.push(`stderr:\n${cap(r.stderr)}`);
      if (r.truncated) parts.push("(output was truncated by the desktop)");
      return { content: [text(parts.join("\n"))], summary: `desktop_exec ${JSON.stringify(args.command.slice(0, 80))} → ${r.timedOut ? "timeout" : (r.exitCode ?? r.signal)}` };
    },
  });

  reg.register({
    name: "ui_tree",
    description:
      "Read the accessibility tree of the desktop's windows (AT-SPI) — the precise way to work with native apps (text editors, file managers, dialogs). One line per element: role \"name\" [states] value=… @x,y box=[x,y,w,h]. @x,y is the point to click in screenshot pixels (visible part of the element, not covered by another window); click it with left_click instead of estimating from the screenshot. Windows are listed topmost first; [active] marks the focused one. Only elements currently on screen are listed: scroll to reveal more. `window` keeps only windows whose title or app name contains that text (case-insensitive) — use it for big trees. For web pages prefer browser_snapshot.",
    inputSchema: obj({ window: { type: "string", description: "Only windows whose title or app name contains this text (case-insensitive)." }, desktop: desktopProp }),
    parse: z.object({ window: z.string().max(200).optional(), desktop: zDesktop }).strict(),
    scope: "desktop",
    async handler(args, ctx) {
      const rd = ctx.desktop!;
      const tree = (await rd.daemon.uiTree(args.window)) as UiTreeRoot;
      const out = formatUiTree(tree, { screen: rd.desktop.screen, window: args.window });
      let body = out.text;
      if (args.window && out.windows === 0 && !tree.stack) {
        // Say which windows exist so the agent can pick a better filter.
        const all = (await rd.daemon.uiTree().catch(() => null)) as UiTreeRoot | null;
        const names = (all?.children ?? []).map((w) => `${JSON.stringify(w.name || "(untitled)")} (${w.app ?? "?"})`);
        body += names.length ? ` Open windows: ${names.join(", ")}.` : " No windows with accessible elements are open.";
      }
      return {
        content: [text(body)],
        summary: `ui_tree${args.window ? ` ${JSON.stringify(args.window)}` : ""} → ${out.windows} window${out.windows === 1 ? "" : "s"}, ${out.elements} elements${out.truncated ? " (truncated)" : ""}`,
      };
    },
  });
}

/** The exact computer-use tool names and their parameter names, for contract tests. */
export const COMPUTER_TOOLSET: Record<string, string[]> = {
  screenshot: [],
  zoom: ["region"],
  left_click: ["coordinate", "text"],
  right_click: ["coordinate", "text"],
  middle_click: ["coordinate", "text"],
  double_click: ["coordinate", "text"],
  triple_click: ["coordinate", "text"],
  left_click_drag: ["start_coordinate", "coordinate", "text"],
  left_mouse_down: [],
  left_mouse_up: [],
  mouse_move: ["coordinate"],
  cursor_position: [],
  scroll: ["scroll_direction", "scroll_amount", "coordinate", "text"],
  type: ["text"],
  key: ["text", "repeat"],
  hold_key: ["text", "duration"],
  wait: ["duration"],
};
