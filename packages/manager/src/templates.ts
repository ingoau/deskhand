/**
 * Templates (plan: "Templates"). Phase 2 scope: the `base` record, the default pointer,
 * listing/info, feedback, rollback, delete, and a basic save (quiesce + docker commit as a new
 * version, pruning old versions not in use). Manifests (logged-in sites, extensions, packages)
 * and recipe replay are phase 4.
 */
import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { DeskhandError, type TemplateDescription, type TemplateDetail, type TemplateFeedback, type TemplateSummary, type TemplateVersion } from "@deskhand/shared";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { getMeta, setMeta } from "./db.js";
import type { Runtime } from "./runtime/types.js";
import { nowIso } from "./util.js";

export const BASE_TEMPLATE = "base";
export const TEMPLATE_REPO = "deskhand-template";
const STALE_MS = 14 * 86_400_000;
const AGENT_CHANGE_MS = 86_400_000;

export const BASE_DESCRIPTION: TemplateDescription = {
  summary: "Plain desktop with Chromium, Firefox, a file manager, a text editor and an image viewer; no accounts or logins",
  use_when: "The task needs no saved logins or extra apps, or as the starting point for a new template",
  tags: ["base"],
};

interface VersionRow {
  name: string;
  version: number;
  image: string;
  created_at: string;
  saved_by: string | null;
  by_agent: number;
  base_version: string;
  recipe: string | null;
  description: string;
  logged_in_sites: string;
  extensions: string;
  packages: string;
  size_bytes: number | null;
  removed_at: string | null;
}

export class TemplateService extends EventEmitter {
  /** Counts desktops using a template version; set by the composition root. */
  inUse: (name: string, version: number) => number = () => 0;

  constructor(
    private readonly cfg: Config,
    private readonly db: DB,
    private readonly runtime: Runtime,
    private readonly log: Logger,
  ) {
    super();
    this.ensureBase();
  }

  private ensureBase() {
    const now = nowIso();
    const has = this.db.prepare("SELECT 1 FROM templates WHERE name = ?").get(BASE_TEMPLATE);
    if (!has) {
      this.db.prepare("INSERT INTO templates (name, current_version, created_at, updated_at) VALUES (?, 1, ?, ?)").run(BASE_TEMPLATE, now, now);
      this.db
        .prepare("INSERT INTO template_versions (name, version, image, created_at, saved_by, base_version, description) VALUES (?, 1, '', ?, 'deskhand', ?, ?)")
        .run(BASE_TEMPLATE, now, this.cfg.version, JSON.stringify(BASE_DESCRIPTION));
    }
    if (!getMeta(this.db, "default_template")) setMeta(this.db, "default_template", BASE_TEMPLATE);
  }

  defaultName(): string {
    return getMeta(this.db, "default_template") ?? BASE_TEMPLATE;
  }

  private imageOf(r: VersionRow): string {
    return r.name === BASE_TEMPLATE && r.version === 1 ? this.cfg.desktopImage : r.image;
  }

  private versionRows(name: string): VersionRow[] {
    return this.db.prepare("SELECT * FROM template_versions WHERE name = ? AND removed_at IS NULL ORDER BY version").all(name) as VersionRow[];
  }

  private tplRow(name: string) {
    return this.db.prepare("SELECT * FROM templates WHERE name = ? AND deleted_at IS NULL").get(name) as
      | { name: string; current_version: number; created_at: string; updated_at: string }
      | undefined;
  }

  resolve(name?: string): { name: string; version: number; image: string } {
    const n = name ?? this.defaultName();
    const t = this.tplRow(n);
    if (!t) throw new DeskhandError("template_not_found", `No template named "${n}". Call \`template_list\` to see the available templates.`);
    const v = this.resolveVersion(n, t.current_version);
    if (!v) throw new DeskhandError("template_not_found", `Template "${n}" has no usable version.`);
    return v;
  }

  resolveVersion(name: string, version: number): { name: string; version: number; image: string } | null {
    const r = this.db.prepare("SELECT * FROM template_versions WHERE name = ? AND version = ? AND removed_at IS NULL").get(name, version) as VersionRow | undefined;
    return r ? { name, version, image: this.imageOf(r) } : null;
  }

  private toVersion(r: VersionRow): TemplateVersion {
    return {
      version: r.version,
      image: this.imageOf(r),
      createdAt: r.created_at,
      savedBy: r.saved_by,
      byAgent: r.by_agent === 1,
      baseVersion: r.base_version,
      hasRecipe: !!r.recipe,
      description: JSON.parse(r.description) as TemplateDescription,
      loggedInSites: JSON.parse(r.logged_in_sites) as string[],
      extensions: JSON.parse(r.extensions) as string[],
      packages: JSON.parse(r.packages) as string[],
      sizeBytes: r.size_bytes,
      inUse: this.inUse(r.name, r.version),
    };
  }

  private feedbackRows(name: string, limit = 50): TemplateFeedback[] {
    const rows = this.db.prepare("SELECT * FROM template_feedback WHERE name = ? ORDER BY id DESC LIMIT ?").all(name, limit) as Array<{
      at: string;
      kind: "ok" | "problem";
      note: string;
      by: string | null;
      version: number;
    }>;
    return rows.map((r) => ({ at: r.at, kind: r.kind, note: r.note, by: r.by, version: r.version }));
  }

  private summaryOf(t: { name: string; current_version: number; updated_at: string }): TemplateSummary {
    const versions = this.versionRows(t.name);
    const current = versions.find((v) => v.version === t.current_version) ?? versions[versions.length - 1]!;
    const latest = versions[versions.length - 1]!;
    const fb = this.feedbackRows(t.name, 1)[0] ?? null;
    const lastOk = this.db.prepare("SELECT at FROM template_feedback WHERE name = ? AND kind = 'ok' ORDER BY id DESC LIMIT 1").get(t.name) as { at: string } | undefined;
    const recentAgent = versions.some((v) => v.by_agent === 1 && Date.now() - Date.parse(v.created_at) < AGENT_CHANGE_MS);
    const confirmed = lastOk?.at ?? null;
    const isBase = t.name === BASE_TEMPLATE;
    return {
      name: t.name,
      currentVersion: t.current_version,
      latestVersion: latest.version,
      description: JSON.parse(current.description) as TemplateDescription,
      loggedInSites: JSON.parse(current.logged_in_sites) as string[],
      updatedAt: t.updated_at,
      recentlyChangedByAgent: recentAgent,
      lastFeedback: fb,
      lastConfirmedAt: confirmed,
      stale: !isBase && (!confirmed || Date.now() - Date.parse(confirmed) > STALE_MS) && Date.now() - Date.parse(current.created_at) > STALE_MS,
      outdatedBase: !isBase && current.base_version !== this.cfg.version && !current.recipe,
      isDefault: this.defaultName() === t.name,
    };
  }

  list(): TemplateSummary[] {
    const rows = this.db.prepare("SELECT * FROM templates WHERE deleted_at IS NULL ORDER BY name = 'base' DESC, name").all() as Array<{
      name: string;
      current_version: number;
      updated_at: string;
    }>;
    return rows.map((r) => this.summaryOf(r));
  }

  info(name: string): TemplateDetail {
    const t = this.tplRow(name);
    if (!t) throw new DeskhandError("template_not_found", `No template named "${name}". Call \`template_list\` to see the available templates.`);
    const versions = this.versionRows(name);
    const current = versions.find((v) => v.version === t.current_version);
    return {
      ...this.summaryOf(t),
      versions: versions.map((v) => this.toVersion(v)).reverse(),
      feedback: this.feedbackRows(name),
      recipe: current?.recipe ?? null,
    };
  }

  feedback(name: string, version: number, kind: "ok" | "problem", note: string, by: string | null): TemplateFeedback {
    if (!this.tplRow(name)) throw new DeskhandError("template_not_found");
    const at = nowIso();
    this.db.prepare("INSERT INTO template_feedback (name, version, at, kind, note, by) VALUES (?, ?, ?, ?, ?, ?)").run(name, version, at, kind, note, by);
    this.emit("changed");
    return { at, kind, note, by, version };
  }

  rollback(name: string, version: number): TemplateSummary {
    const t = this.tplRow(name);
    if (!t) throw new DeskhandError("template_not_found");
    if (!this.resolveVersion(name, version)) throw new DeskhandError("invalid_argument", `Template "${name}" has no version ${version}.`);
    this.db.prepare("UPDATE templates SET current_version = ?, updated_at = ? WHERE name = ?").run(version, nowIso(), name);
    this.emit("changed");
    return this.summaryOf(this.tplRow(name)!);
  }

  setDefault(name: string): void {
    if (!this.tplRow(name)) throw new DeskhandError("template_not_found");
    setMeta(this.db, "default_template", name);
    this.emit("changed");
  }

  async delete(name: string): Promise<void> {
    if (name === BASE_TEMPLATE) throw new DeskhandError("invalid_argument", "The base template is built in and cannot be deleted.");
    if (!this.tplRow(name)) throw new DeskhandError("template_not_found");
    const now = nowIso();
    this.db.prepare("UPDATE templates SET deleted_at = ? WHERE name = ?").run(now, name);
    if (this.defaultName() === name) setMeta(this.db, "default_template", BASE_TEMPLATE);
    for (const v of this.versionRows(name)) {
      if (this.inUse(name, v.version) > 0) continue;
      await this.runtime.removeImage(v.image).catch(() => undefined);
      this.db.prepare("UPDATE template_versions SET removed_at = ? WHERE name = ? AND version = ?").run(now, name, v.version);
    }
    this.emit("changed");
  }

  /**
   * Saves a desktop as a new version. The caller quiesces the desktop first.
   * Every save is a new version; `base` cannot be overwritten.
   */
  async save(opts: {
    name: string;
    description: TemplateDescription;
    recipe?: string;
    containerId: string;
    savedBy: string | null;
    byAgent: boolean;
    baseVersion?: string;
  }): Promise<TemplateSummary> {
    const { name } = opts;
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
      throw new DeskhandError("invalid_argument", "Template names use lowercase letters, digits and dashes (up to 40 characters).");
    }
    if (name === BASE_TEMPLATE) throw new DeskhandError("invalid_argument", "`base` is built in; save under a new name (for example `base-plus-<what you added>`).");
    const existing = this.db.prepare("SELECT * FROM templates WHERE name = ?").get(name) as { deleted_at: string | null } | undefined;
    const maxV = (this.db.prepare("SELECT MAX(version) AS v FROM template_versions WHERE name = ?").get(name) as { v: number | null }).v ?? 0;
    const version = maxV + 1;
    const tag = `${name}-v${version}`;
    const { image, sizeBytes } = await this.runtime.commit(opts.containerId, {
      repo: TEMPLATE_REPO,
      tag,
      labels: {
        "deskhand.template": name,
        "deskhand.template-version": String(version),
        "deskhand.id": "",
        "deskhand.session": "",
        "deskhand.title": "",
        "deskhand.persistent": "false",
        "deskhand.created": nowIso(),
      },
      env: ["DESKHAND_DAEMON_KEY="],
    });
    const now = nowIso();
    this.db.transaction(() => {
      if (!existing) this.db.prepare("INSERT INTO templates (name, current_version, created_at, updated_at) VALUES (?, ?, ?, ?)").run(name, version, now, now);
      else this.db.prepare("UPDATE templates SET current_version = ?, updated_at = ?, deleted_at = NULL WHERE name = ?").run(version, now, name);
      this.db
        .prepare(
          "INSERT INTO template_versions (name, version, image, created_at, saved_by, by_agent, base_version, recipe, description, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(name, version, image, now, opts.savedBy, opts.byAgent ? 1 : 0, opts.baseVersion ?? this.cfg.version, opts.recipe ?? null, JSON.stringify(opts.description), sizeBytes);
    })();
    this.log.info({ template: name, version, image }, "template saved");
    await this.prune(name);
    this.emit("changed");
    return this.summaryOf(this.tplRow(name)!);
  }

  /** Keeps the newest N versions plus the current one and any in use. */
  async prune(name: string): Promise<void> {
    const t = this.tplRow(name);
    if (!t || name === BASE_TEMPLATE) return;
    const versions = this.versionRows(name);
    const keep = new Set(versions.slice(-this.cfg.templateVersions).map((v) => v.version));
    keep.add(t.current_version);
    for (const v of versions) {
      if (keep.has(v.version) || this.inUse(name, v.version) > 0) continue;
      await this.runtime.removeImage(v.image).catch((e) => this.log.warn({ err: (e as Error).message, image: v.image }, "could not remove old template image"));
      this.db.prepare("UPDATE template_versions SET removed_at = ? WHERE name = ? AND version = ?").run(nowIso(), name, v.version);
    }
  }
}
