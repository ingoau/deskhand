/** GET /ui-tree: runs the bundled pyatspi helper as the agent user. */
import { DeskhandError, type UiNodeT } from "@deskhand/shared";
import { runExec } from "./exec.js";

export const UITREE_HELPER = process.env.DESKHAND_UITREE_HELPER ?? "/opt/deskhand/uitree.py";

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function uiTree(window?: string): Promise<UiNodeT> {
  const args = [`python3 -I ${shq(UITREE_HELPER)}`, "--timeout 12"];
  if (window) args.push(`--window ${shq(window)}`);
  const r = await runExec({ command: args.join(" "), timeoutMs: 15_000, maxOutputBytes: 16 * 1024 * 1024 });
  if (r.timedOut) throw new DeskhandError("timeout", "Reading the accessibility tree took too long; an app may be unresponsive. Try again or pass `window`.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new DeskhandError("internal", `The accessibility helper failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  }
  const p = parsed as { error?: string; message?: string };
  if (p.error === "timeout") throw new DeskhandError("timeout", p.message);
  if (p.error) throw new DeskhandError("internal", p.message ?? p.error);
  return parsed as UiNodeT;
}
