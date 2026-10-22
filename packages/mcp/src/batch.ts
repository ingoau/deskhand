/**
 * `batch`: runs several input actions in one tool call (e.g. click a field, type, press Return) and
 * returns one screenshot at the end instead of one per action, saving round trips and tokens.
 *
 * Each step is an ordinary input tool (pixel tools, wait, desktop_exec, browser_*), validated by that
 * tool's own schema before anything runs and executed by its own handler, so lock/generation checks,
 * coordinate checks and settling work exactly as for single calls. Steps run in order and the batch
 * stops at the first one that fails or finds that control changed. Every step gets its own action-log
 * entry (with its settled screenshot and overlays); the batch itself is not logged.
 */
import { z } from "zod";
import { DeskhandError, ERROR_MESSAGES } from "@deskhand/shared";
import { handbackNote, text, UNKNOWN_NOTE, type Content, type ToolContext, type ToolOutput, type ToolRegistry } from "./registry.js";

export const BATCH_MAX_STEPS = 50;
/** Input tools that cannot be a step: request_human waits for the user, and batches don't nest. */
const NOT_BATCHABLE = new Set(["batch", "request_human"]);

function batchable(reg: ToolRegistry, name: string): boolean {
  const def = reg.get(name);
  return !!def && def.scope === "desktop" && !!def.input && !NOT_BATCHABLE.has(name);
}

const zStep = z.object({ action: z.string().min(1).max(64) }).passthrough();

export function registerBatchTool(reg: ToolRegistry): void {
  reg.register({
    name: "batch",
    description: [
      `Run up to ${BATCH_MAX_STEPS} input actions in order in one call and get one screenshot at the end, e.g. click a field, type, press Return.`,
      'Each step is {"action": <tool name>, ...that tool\'s arguments}: any input tool — left_click, double_click, right_click, mouse_move, left_click_drag, left_mouse_down/up, scroll, type, key, hold_key, wait, desktop_exec or a browser_* action (not request_human). Steps take no `desktop`; pass it on the batch.',
      "Each step waits for the screen to settle before the next one. All steps are validated before any runs; the batch stops at the first step that fails or finds that the user took control, and says which steps ran.",
      "Batch only steps whose outcome you can predict from the current screen; when a step's result decides the next action, use separate calls.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: BATCH_MAX_STEPS,
          description: 'The steps, e.g. [{"action":"left_click","coordinate":[640,300]},{"action":"type","text":"hello"},{"action":"key","text":"Return"}].',
          items: {
            type: "object",
            properties: { action: { type: "string", description: "Input tool name, e.g. left_click, type, key, browser_click." } },
            required: ["action"],
            additionalProperties: true,
          },
        },
        desktop: {
          type: "string",
          description: "Which desktop: an id from desktop_start or desktop_list. Defaults to this session's first desktop (started automatically if there is none).",
        },
      },
      required: ["actions"],
      additionalProperties: false,
    },
    parse: z.object({ actions: z.array(zStep).min(1).max(BATCH_MAX_STEPS), desktop: z.string().min(1).max(64).optional() }).strict(),
    scope: "desktop",
    input: true,
    screenDependent: true,
    summarize: (a) => `batch ${a.actions.length} step${a.actions.length === 1 ? "" : "s"}: ${a.actions.map((s) => s.action).join(", ").slice(0, 120)}`,
    async handler(args, ctx) {
      // Validate every step up front, so a typo in step 5 doesn't leave steps 1–4 done.
      const steps: Array<{ tool: string; args: Record<string, unknown> }> = [];
      for (const [i, raw] of args.actions.entries()) {
        const { action: tool, ...rest } = raw;
        const where = `actions.${i} (${tool})`;
        if (!batchable(reg, tool)) {
          const why = reg.get(tool) ? "cannot be a batch step (only input tools other than request_human can)" : "is not a tool";
          throw new DeskhandError("invalid_argument", `${where}: ${tool} ${why}.`);
        }
        if ("desktop" in rest) throw new DeskhandError("invalid_argument", `${where}: steps take no desktop; pass it on the batch.`);
        const parsed = reg.get(tool)!.parse.safeParse(rest);
        if (!parsed.success) {
          const issue = (parsed.error as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues?.[0];
          throw new DeskhandError("invalid_argument", `${where}: ${issue ? `${issue.path.map(String).join(".")}${issue.path.length ? ": " : ""}${issue.message}` : ERROR_MESSAGES.invalid_argument}`);
        }
        steps.push({ tool, args: parsed.data as Record<string, unknown> });
      }

      const rd = ctx.desktop!;
      const lines: string[] = [];
      let last: ToolOutput | null = null;
      let isError = false;
      let error: ToolOutput["error"];

      for (const [i, step] of steps.entries()) {
        if (ctx.signal.aborted) {
          lines.push(`Stopped before step ${i + 1}: the call was cancelled.`);
          break;
        }
        ctx.progress(i, steps.length, `Step ${i + 1} of ${steps.length}: ${step.tool}`);
        const t0 = Date.now();
        const record = (out: Partial<ToolOutput>, outcome: "ok" | "error" | "unknown") =>
          ctx.backend.recordAction({
            desktopId: rd.desktop.id,
            sessionId: ctx.session.id,
            actor: ctx.actor,
            tool: step.tool,
            args: step.args,
            summary: out.summary ?? reg.summaryOf(step.tool, step.args),
            outcome,
            error: out.error ?? null,
            durationMs: Date.now() - t0,
            overlays: out.overlays ?? [],
            screenshot: out.logScreenshot ?? null,
          });
        const seen = ctx.generation;
        const notRun = steps.length - i - 1;
        const controlChanged = async () => {
          const st = await rd.daemon.state().catch(() => null);
          if (st) {
            lines.push(handbackNote(st, seen));
            ctx.markSeen(st.generation);
          }
        };
        try {
          const out = await reg.get(step.tool)!.handler(step.args, ctx);
          if (!out.skipLog) record(out, out.isError ? "error" : "ok");
          const said = out.content.filter((c): c is Extract<Content, { type: "text" }> => c.type === "text").map((c) => c.text);
          lines.push(`${i + 1}. ${step.tool}: ${said.join("\n") || "done."}`);
          last = out;
          if (out.isError) {
            isError = true;
            error = out.error;
            if (notRun) lines.push(`Stopped at step ${i + 1}; the ${notRun} step(s) after it were not run.`);
            break;
          }
          if (ctx.generation !== seen && notRun) {
            // The user took over and handed back while this step ran: the rest was planned for a screen that may be gone.
            await controlChanged();
            lines.push(`Control of the desktop changed during step ${i + 1}, so the ${notRun} step(s) after it were not performed. Look at this screenshot and decide again.`);
            break;
          }
        } catch (e) {
          last = null;
          const err = e instanceof DeskhandError ? e : null;
          const code = err?.code ?? "internal";
          const message = err?.message ?? ERROR_MESSAGES.internal;
          const rest = notRun ? ` and the ${notRun} step(s) after it were` : " was";
          if (code === "control_changed") {
            await controlChanged();
            lines.push(`Step ${i + 1} (${step.tool})${rest} not performed because control of the desktop changed. Look at this screenshot and decide again.`);
            record({ error: { code, message } }, "error");
          } else {
            if (code === "outcome_unknown") ctx.state.addPending(rd.desktop.id, UNKNOWN_NOTE, true);
            lines.push(`Step ${i + 1} (${step.tool}) failed: Error (${code}): ${message}${notRun ? ` The ${notRun} step(s) after it were not run.` : ""}`);
            record({ error: { code, message } }, code === "outcome_unknown" ? "unknown" : "error");
            isError = true;
            error = { code, message };
          }
          break;
        }
      }

      // One screenshot at the end: the last step's settled one, else a fresh capture.
      let images = last?.hasScreenshot ? last.content.filter((c) => c.type === "image") : [];
      if (!images.length) {
        try {
          const shot = await rd.daemon.screenshot({ format: "png" });
          const img = await ctx.backend.encodeForAgent(Buffer.from(shot.data, "base64"));
          images = [{ type: "image", data: img.data, mimeType: img.mimeType }];
        } catch {
          lines.push("(Could not capture a screenshot.)");
        }
      }
      return { content: [text(lines.join("\n")), ...images], hasScreenshot: images.length > 0, skipLog: true, ...(isError ? { isError, error } : {}) };
    },
  });
}
