/**
 * Action log (design.md "Action log"): one SQLite row per agent or dashboard action plus
 * screenshot files in the data dir: shots/<desktop>/<id>.webp and <id>.thumb.webp.
 * Retention: full screenshots for DESKHAND_LOG_RETENTION, then thumbnails only; rows and
 * thumbnails of removed desktops go after DESKHAND_LOG_THUMB_RETENTION.
 */
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { LogEntry, Overlay } from "@deskhand/shared";
import type { DB } from "./db.js";
import { encodeForLog } from "./images.js";

export interface ActionInput {
  desktopId: string;
  tool: string;
  args?: unknown;
  summary: string;
  outcome: "ok" | "error" | "unknown";
  error?: { code: string; message: string } | null;
  actor: string | null;
  session: string | null;
  durationMs?: number | null;
  overlays?: Overlay[];
  /** Any image format sharp can read. */
  screenshot?: Buffer | null;
  at?: string;
}

interface Row {
  id: number;
  desktop_id: string;
  at: string;
  tool: string;
  args: string | null;
  summary: string;
  outcome: "ok" | "error" | "unknown";
  error_code: string | null;
  error_message: string | null;
  actor: string | null;
  session: string | null;
  duration_ms: number | null;
  overlays: string;
  shot: number;
  full_pruned: number;
}

/** Redacts obviously sensitive argument values before they are stored. */
function scrubArgs(args: unknown): unknown {
  if (!args || typeof args !== "object") return args ?? null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 2000) out[k] = v.slice(0, 2000) + "…";
    else out[k] = v;
  }
  return out;
}

export class ActionLog {
  private diskBytesCache = 0;
  private pending = new Set<Promise<unknown>>();

  constructor(
    private readonly db: DB,
    private readonly dir: string,
    private readonly log: Logger,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.diskBytesCache = this.measure();
  }

  private paths(desktopId: string, id: number) {
    const d = path.join(this.dir, desktopId.replace(/[^A-Za-z0-9_-]/g, "_"));
    return { dir: d, full: path.join(d, `${id}.webp`), thumb: path.join(d, `${id}.thumb.webp`) };
  }

  /** Inserts the row now; screenshot files are written in the background. */
  record(a: ActionInput): number {
    const r = this.db
      .prepare(
        `INSERT INTO action_log (desktop_id, at, tool, args, summary, outcome, error_code, error_message, actor, session, duration_ms, overlays, shot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        a.desktopId,
        a.at ?? new Date().toISOString(),
        a.tool,
        JSON.stringify(scrubArgs(a.args)),
        a.summary,
        a.outcome,
        a.error?.code ?? null,
        a.error?.message ?? null,
        a.actor,
        a.session,
        a.durationMs ?? null,
        JSON.stringify(a.overlays ?? []),
      );
    const id = Number(r.lastInsertRowid);
    if (a.screenshot) {
      const p = this.writeShot(a.desktopId, id, a.screenshot).catch((e) => this.log.warn({ err: (e as Error).message, id }, "could not store log screenshot"));
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    }
    return id;
  }

  private async writeShot(desktopId: string, id: number, img: Buffer) {
    const { full, thumb } = await encodeForLog(img);
    const p = this.paths(desktopId, id);
    await fs.promises.mkdir(p.dir, { recursive: true });
    await fs.promises.writeFile(p.full, full);
    await fs.promises.writeFile(p.thumb, thumb);
    this.diskBytesCache += full.length + thumb.length;
    this.db.prepare("UPDATE action_log SET shot = 1 WHERE id = ?").run(id);
  }

  /** Waits for background screenshot writes (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private toEntry(r: Row): LogEntry {
    return {
      id: r.id,
      desktopId: r.desktop_id,
      at: r.at,
      tool: r.tool,
      args: r.args ? JSON.parse(r.args) : null,
      summary: r.summary,
      outcome: r.outcome,
      error: r.error_code ? { code: r.error_code, message: r.error_message ?? "" } : null,
      actor: r.actor,
      session: r.session,
      durationMs: r.duration_ms,
      overlays: JSON.parse(r.overlays) as Overlay[],
      hasScreenshot: r.shot === 1,
    };
  }

  /** Newest first. */
  list(desktopId: string, opts: { before?: number; limit?: number } = {}): LogEntry[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const rows = (
      opts.before
        ? this.db.prepare("SELECT * FROM action_log WHERE desktop_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(desktopId, opts.before, limit)
        : this.db.prepare("SELECT * FROM action_log WHERE desktop_id = ? ORDER BY id DESC LIMIT ?").all(desktopId, limit)
    ) as Row[];
    return rows.map((r) => this.toEntry(r));
  }

  get(id: number): LogEntry | null {
    const r = this.db.prepare("SELECT * FROM action_log WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toEntry(r) : null;
  }

  /** File path of a stored screenshot; falls back to the thumbnail once the full one is pruned. */
  screenshotFile(id: number, thumb: boolean): string | null {
    const r = this.db.prepare("SELECT desktop_id, shot, full_pruned FROM action_log WHERE id = ?").get(id) as
      | { desktop_id: string; shot: number; full_pruned: number }
      | undefined;
    if (!r || !r.shot) return null;
    const p = this.paths(r.desktop_id, id);
    const file = thumb || r.full_pruned ? p.thumb : p.full;
    return fs.existsSync(file) ? file : fs.existsSync(p.thumb) ? p.thumb : null;
  }

  latestScreenshotFile(desktopId: string, thumb: boolean): string | null {
    const r = this.db.prepare("SELECT id FROM action_log WHERE desktop_id = ? AND shot = 1 ORDER BY id DESC LIMIT 1").get(desktopId) as { id: number } | undefined;
    return r ? this.screenshotFile(r.id, thumb) : null;
  }

  /**
   * Retention: drop full screenshots older than fullMs (keep thumbs); delete rows + thumbs of
   * removed desktops older than thumbMs.
   */
  prune(opts: { fullMs: number; thumbMs: number; removedDesktopIds: () => Set<string>; now?: number }): { prunedFull: number; deleted: number } {
    const now = opts.now ?? Date.now();
    const fullCutoff = new Date(now - opts.fullMs).toISOString();
    const old = this.db.prepare("SELECT id, desktop_id FROM action_log WHERE shot = 1 AND full_pruned = 0 AND at < ?").all(fullCutoff) as Array<{ id: number; desktop_id: string }>;
    for (const r of old) {
      const p = this.paths(r.desktop_id, r.id);
      fs.rmSync(p.full, { force: true });
    }
    if (old.length) {
      const mark = this.db.prepare("UPDATE action_log SET full_pruned = 1 WHERE id = ?");
      this.db.transaction(() => old.forEach((r) => mark.run(r.id)))();
    }
    const thumbCutoff = new Date(now - opts.thumbMs).toISOString();
    const removed = opts.removedDesktopIds();
    const gone = this.db.prepare("SELECT id, desktop_id FROM action_log WHERE at < ?").all(thumbCutoff) as Array<{ id: number; desktop_id: string }>;
    const del = gone.filter((r) => removed.has(r.desktop_id));
    for (const r of del) {
      const p = this.paths(r.desktop_id, r.id);
      fs.rmSync(p.full, { force: true });
      fs.rmSync(p.thumb, { force: true });
    }
    if (del.length) {
      const stmt = this.db.prepare("DELETE FROM action_log WHERE id = ?");
      this.db.transaction(() => del.forEach((r) => stmt.run(r.id)))();
    }
    this.diskBytesCache = this.measure();
    return { prunedFull: old.length, deleted: del.length };
  }

  private measure(): number {
    let total = 0;
    const walk = (d: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else
          try {
            total += fs.statSync(p).size;
          } catch {
            /* raced */
          }
      }
    };
    walk(this.dir);
    return total;
  }

  diskBytes(): number {
    return this.diskBytesCache;
  }
}
