/**
 * Templates (plan: "Templates"): records, versions, manifests, descriptions, feedback and the
 * stale marker, rollback/default/delete, recipes, base-image tracking and cleanup.
 *
 * - `base` is the desktop image itself (version 1, never committed). Saved versions are images
 *   `<DESKHAND_TEMPLATE_REPO>:<name>-v<N>` made by quiesce + `docker commit` (see mcp-backend's
 *   saveDesktopAsTemplate) — every save is a new version, never an overwrite.
 * - Each version records the base image it was built on (version string + image id). When the
 *   manager runs a different desktop image, recipe-backed templates are rebuilt (rebuild.ts) and
 *   snapshot-only ones are flagged `outdatedBase`.
 */
import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import {
  DeskhandError,
  type TemplateChanges,
  type TemplateDescription,
  type TemplateDetail,
  type TemplateFeedback,
  type TemplateSummary,
  type TemplateVersion,
} from "@deskhand/shared";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { getMeta, setMeta } from "./db.js";
import type { Manifest } from "./manifest.js";
import type { Runtime } from "./runtime/types.js";
import { KeyedMutex, nowIso } from "./util.js";

export const BASE_TEMPLATE = "base";
/** Default image repository for template versions (DESKHAND_TEMPLATE_REPO overrides it). */
export const TEMPLATE_REPO = "deskhand-template";
const AGENT_CHANGE_MS = 86_400_000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const BASE_DESCRIPTION: TemplateDescription = {
  summary: "Plain desktop with Chromium, Firefox, a file manager, a text editor and an image viewer; no accounts or logins",
  use_when: "The task needs no saved logins or extra apps, or as the starting point for a new template",
  tags: ["base"],
};

export interface BaseInfo {
  /** Human-readable, e.g. "0.1.0+20261022.101112". */
  version: string;
  /** Image id of the desktop image (null when it could not be inspected). */
  imageId: string | null;
}

export type RebuildState = NonNullable<TemplateSummary["rebuild"]>;

interface VersionRow {
  name: string;
  version: number;
  image: string;
  created_at: string;
  saved_by: string | null;
  by_agent: number;
  base_version: string;
  base_image_id: string | null;
  recipe: string | null;
  description: string;
  logged_in_sites: string;
  extensions: string;
  packages: string;
  manifest_notes: string;
  saved_from: string | null;
  rebuilt_from: number | null;
  size_bytes: number | null;
  removed_at: string | null;
}

interface TplRow {
  name: string;
  current_version: number;
  created_at: string;
  updated_at: string;
  rebuild: string | null;
}

interface FeedbackRow {
  at: string;
  kind: "ok" | "problem";
  note: string;
  by: string | null;
  version: number;
  session: string | null;
}

export interface SaveInput {
  name: string;
  description?: TemplateDescription;
  confirm_description?: boolean;
  recipe?: string | null;
}

export interface PreparedSave {
  name: string;
  description: TemplateDescription;
  recipe: string | null;
  isNew: boolean;
}

export interface SaveOptions {
  prepared: PreparedSave;
  containerId: string;
  savedBy: string | null;
  byAgent: boolean;
  base: BaseInfo;
  manifest: Manifest;
  savedFrom?: { desktop: string; title: string | null; session: string | null } | null;
  rebuiltFrom?: number | null;
}

function parseList(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function listChange(before: string[], after: string[]) {
  const b = new Set(before);
  const a = new Set(after);
  return { added: after.filter((x) => !b.has(x)), removed: before.filter((x) => !a.has(x)) };
}

const DESC_FIELDS: Array<keyof TemplateDescription> = ["summary", "use_when", "not_for", "setup_notes", "tags"];

interface Diffable {
  description: TemplateDescription;
  loggedInSites: string[];
  extensions: string[];
  packages: string[];
  recipe?: string | null;
  baseVersion: string;
}

export function diffRows(prev: (Diffable & { version: number }) | null, next: Diffable): TemplateChanges {
  const empty: TemplateDescription = { summary: "", use_when: "" };
  const pd = prev?.description ?? empty;
  const description = DESC_FIELDS.filter((f) => JSON.stringify(pd[f] ?? null) !== JSON.stringify(next.description[f] ?? null)).map((f) => ({
    field: f,
    before: pd[f] ?? null,
    after: next.description[f] ?? null,
  }));
  return {
    from: prev?.version ?? null,
    description,
    loggedInSites: listChange(prev?.loggedInSites ?? [], next.loggedInSites),
    extensions: listChange(prev?.extensions ?? [], next.extensions),
    packages: listChange(prev?.packages ?? [], next.packages),
    recipeChanged: (prev?.recipe ?? null) !== (next.recipe ?? null),
    baseChanged: !!prev && prev.baseVersion !== next.baseVersion,
  };
}

/** "0.1.0" + image created 2026-10-22T10:11:12Z → "0.1.0+20261022.101112". */
export function baseVersionString(version: string, created: string): string {
  const d = new Date(created);
  if (Number.isNaN(d.getTime())) return version;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${version}+${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}.${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export class TemplateService extends EventEmitter {
  /** Counts desktops using a template version; set by the composition root. */
  inUse: (name: string, version: number) => number = () => 0;
  private readonly mutex = new KeyedMutex();
  /** The desktop image the manager runs now. Updated by initBase(). */
  base: BaseInfo;

  constructor(
    private readonly cfg: Config,
    private readonly db: DB,
    private readonly runtime: Runtime,
    private readonly log: Logger,
  ) {
    super();
    this.setMaxListeners(1000);
    const stored = this.db.prepare("SELECT base_version, base_image_id FROM template_versions WHERE name = ? AND version = 1").get(BASE_TEMPLATE) as
      | { base_version: string; base_image_id: string | null }
      | undefined;
    this.base = { version: stored?.base_version ?? cfg.version, imageId: stored?.base_image_id ?? null };
    this.ensureBase();
  }

  get repo(): string {
    return this.cfg.templateRepo;
  }

  private ensureBase() {
    const now = nowIso();
    const has = this.db.prepare("SELECT 1 FROM templates WHERE name = ?").get(BASE_TEMPLATE);
    if (!has) {
      this.db.prepare("INSERT INTO templates (name, current_version, created_at, updated_at) VALUES (?, 1, ?, ?)").run(BASE_TEMPLATE, now, now);
      this.db
        .prepare("INSERT INTO template_versions (name, version, image, created_at, saved_by, base_version, description) VALUES (?, 1, '', ?, 'deskhand', ?, ?)")
        .run(BASE_TEMPLATE, now, this.base.version, JSON.stringify(BASE_DESCRIPTION));
    }
    if (!getMeta(this.db, "default_template")) setMeta(this.db, "default_template", BASE_TEMPLATE);
  }

  /**
   * Inspects the desktop image and records it as the base. Returns true when it differs from the
   * base recorded at the previous start (a base-image update).
   */
  async initBase(): Promise<{ changed: boolean; previous: BaseInfo; current: BaseInfo }> {
    const previous = { ...this.base };
    let info = null;
    try {
      info = await this.runtime.imageInfo(this.cfg.desktopImage);
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "could not inspect the desktop image; base version unknown");
    }
    if (!info) return { changed: false, previous, current: previous };
    const version = baseVersionString(info.labels["deskhand.version"] || info.labels["org.opencontainers.image.version"] || this.cfg.version, info.created);
    this.base = { version, imageId: info.id };
    this.db.prepare("UPDATE template_versions SET base_version = ?, base_image_id = ? WHERE name = ? AND version = 1").run(version, info.id, BASE_TEMPLATE);
    const prevId = getMeta(this.db, "base_image_id");
    setMeta(this.db, "base_image_id", info.id);
    setMeta(this.db, "base_version", version);
    const changed = !!prevId && prevId !== info.id;
    if (changed) {
      this.log.info({ from: previous.version, to: version }, "desktop image changed (base update)");
      this.emit("changed");
    }
    return { changed, previous, current: this.base };
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

  private versionRow(name: string, version: number): VersionRow | undefined {
    return this.db.prepare("SELECT * FROM template_versions WHERE name = ? AND version = ? AND removed_at IS NULL").get(name, version) as VersionRow | undefined;
  }

  private tplRow(name: string): TplRow | undefined {
    return this.db.prepare("SELECT * FROM templates WHERE name = ? AND deleted_at IS NULL").get(name) as TplRow | undefined;
  }

  private requireTpl(name: string): TplRow {
    const t = this.tplRow(name);
    if (!t) throw new DeskhandError("template_not_found", `No template named "${name}". Call \`template_list\` to see the available templates.`);
    return t;
  }

  names(): string[] {
    return (this.db.prepare("SELECT name FROM templates WHERE deleted_at IS NULL ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  }

  resolve(name?: string): { name: string; version: number; image: string } {
    const n = name ?? this.defaultName();
    const t = this.requireTpl(n);
    const v = this.resolveVersion(n, t.current_version);
    if (!v) throw new DeskhandError("template_not_found", `Template "${n}" has no usable version.`);
    return v;
  }

  resolveVersion(name: string, version: number): { name: string; version: number; image: string } | null {
    const r = this.versionRow(name, version);
    return r ? { name, version, image: this.imageOf(r) } : null;
  }

  /** The base image a desktop started from this template version runs on. */
  baseOf(name: string, version: number): BaseInfo {
    if (name === BASE_TEMPLATE) return this.base;
    const r = this.versionRow(name, version);
    return r ? { version: r.base_version, imageId: r.base_image_id } : this.base;
  }

  /** The current version's row (with recipe), for rebuilds. */
  current(name: string): { version: number; image: string; recipe: string | null; description: TemplateDescription; base: BaseInfo } {
    const t = this.requireTpl(name);
    const r = this.versionRow(name, t.current_version);
    if (!r) throw new DeskhandError("template_not_found", `Template "${name}" has no usable version.`);
    return { version: r.version, image: this.imageOf(r), recipe: r.recipe, description: JSON.parse(r.description) as TemplateDescription, base: { version: r.base_version, imageId: r.base_image_id } };
  }

  isOutdated(base: BaseInfo): boolean {
    if (base.imageId && this.base.imageId) return base.imageId !== this.base.imageId;
    return base.version !== this.base.version;
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
      loggedInSites: parseList(r.logged_in_sites),
      extensions: parseList(r.extensions),
      packages: parseList(r.packages),
      sizeBytes: r.size_bytes,
      inUse: this.inUse(r.name, r.version),
      savedFrom: r.saved_from ? (JSON.parse(r.saved_from) as TemplateVersion["savedFrom"]) : null,
      rebuiltFrom: r.rebuilt_from,
      manifestNotes: parseList(r.manifest_notes),
      recipe: r.recipe,
    };
  }

  private feedbackRows(name: string, limit = 50): TemplateFeedback[] {
    const rows = this.db.prepare("SELECT * FROM template_feedback WHERE name = ? ORDER BY id DESC LIMIT ?").all(name, limit) as FeedbackRow[];
    return rows.map((r) => ({ at: r.at, kind: r.kind, note: r.note, by: r.by, version: r.version, session: r.session }));
  }

  private rebuildState(t: TplRow): RebuildState | null {
    if (!t.rebuild) return null;
    try {
      return JSON.parse(t.rebuild) as RebuildState;
    } catch {
      return null;
    }
  }

  private summaryOf(t: TplRow): TemplateSummary {
    const versions = this.versionRows(t.name);
    const current = versions.find((v) => v.version === t.current_version) ?? versions[versions.length - 1]!;
    const latest = versions[versions.length - 1]!;
    const fb = this.feedbackRows(t.name, 1)[0] ?? null;
    const isBase = t.name === BASE_TEMPLATE;
    const now = Date.now();
    // Feedback about the version agents get now is what counts for stale / confirmed.
    const curFb = this.db.prepare("SELECT * FROM template_feedback WHERE name = ? AND version = ? ORDER BY id DESC LIMIT 1").get(t.name, current.version) as FeedbackRow | undefined;
    const lastOk = this.db.prepare("SELECT at FROM template_feedback WHERE name = ? AND version = ? AND kind = 'ok' ORDER BY id DESC LIMIT 1").get(t.name, current.version) as
      | { at: string }
      | undefined;
    const confirmed = lastOk?.at ?? null;
    const freshSince = Math.max(confirmed ? Date.parse(confirmed) : 0, Date.parse(current.created_at));
    let staleReason: string | null = null;
    if (!isBase) {
      if (curFb?.kind === "problem") staleReason = `problem reported: ${curFb.note}`;
      else if (now - freshSince > this.cfg.templateStaleMs) staleReason = `not confirmed working in ${Math.round(this.cfg.templateStaleMs / 86_400_000)} days`;
    }
    const agentAt = versions.filter((v) => v.by_agent === 1).map((v) => v.created_at).sort().pop() ?? null;
    const rebuild = this.rebuildState(t);
    const outdated = !isBase && this.isOutdated({ version: current.base_version, imageId: current.base_image_id });
    return {
      name: t.name,
      currentVersion: t.current_version,
      latestVersion: latest.version,
      description: JSON.parse(current.description) as TemplateDescription,
      loggedInSites: parseList(current.logged_in_sites),
      updatedAt: t.updated_at,
      recentlyChangedByAgent: !!agentAt && now - Date.parse(agentAt) < AGENT_CHANGE_MS,
      lastFeedback: fb,
      lastConfirmedAt: confirmed,
      stale: staleReason !== null,
      outdatedBase: outdated && (!current.recipe || rebuild?.status === "failed"),
      isDefault: this.defaultName() === t.name,
      staleReason,
      changedByAgentAt: agentAt,
      hasRecipe: !!current.recipe,
      baseVersion: current.base_version,
      currentBaseVersion: this.base.version,
      extensions: parseList(current.extensions),
      rebuild,
    };
  }

  list(): TemplateSummary[] {
    const rows = this.db.prepare("SELECT * FROM templates WHERE deleted_at IS NULL ORDER BY name = 'base' DESC, name").all() as TplRow[];
    return rows.map((r) => this.summaryOf(r));
  }

  get(name: string): TemplateSummary {
    return this.summaryOf(this.requireTpl(name));
  }

  info(name: string): TemplateDetail {
    const t = this.requireTpl(name);
    const rows = this.versionRows(name);
    const versions = rows.map((r) => this.toVersion(r));
    for (let i = 0; i < versions.length; i++) versions[i]!.changes = diffRows(i ? versions[i - 1]! : null, versions[i]!);
    const current = rows.find((v) => v.version === t.current_version);
    return {
      ...this.summaryOf(t),
      versions: versions.reverse(),
      feedback: this.feedbackRows(name),
      recipe: current?.recipe ?? null,
    };
  }

  /** What changed between two kept versions (default: the current one vs the one before it). */
  diff(name: string, from?: number, to?: number): TemplateChanges {
    const t = this.requireTpl(name);
    const rows = this.versionRows(name);
    const toV = to ?? t.current_version;
    const b = rows.find((r) => r.version === toV);
    if (!b) throw new DeskhandError("invalid_argument", `Template "${name}" has no version ${toV}.`);
    const fromV = from ?? rows.filter((r) => r.version < toV).pop()?.version;
    const a = fromV === undefined ? undefined : rows.find((r) => r.version === fromV);
    if (fromV !== undefined && !a) throw new DeskhandError("invalid_argument", `Template "${name}" has no version ${fromV}.`);
    const va = a ? this.toVersion(a) : null;
    const vb = this.toVersion(b);
    return diffRows(va, vb);
  }

  feedback(name: string, version: number, kind: "ok" | "problem", note: string, by: string | null, session: string | null = null): TemplateFeedback {
    this.requireTpl(name);
    const at = nowIso();
    this.db.prepare("INSERT INTO template_feedback (name, version, at, kind, note, by, session) VALUES (?, ?, ?, ?, ?, ?, ?)").run(name, version, at, kind, note, by, session);
    this.emit("changed");
    return { at, kind, note, by, version, session };
  }

  /** Points the name at an earlier kept version (default: the one before the current version). */
  rollback(name: string, version?: number): TemplateSummary {
    const t = this.requireTpl(name);
    const target = version ?? this.versionRows(name).filter((v) => v.version < t.current_version).pop()?.version;
    if (target === undefined) throw new DeskhandError("invalid_argument", `Template "${name}" has no earlier version to roll back to.`);
    if (!this.resolveVersion(name, target)) throw new DeskhandError("invalid_argument", `Template "${name}" has no version ${target}.`);
    this.db.prepare("UPDATE templates SET current_version = ?, updated_at = ? WHERE name = ?").run(target, nowIso(), name);
    this.log.info({ template: name, version: target }, "template rolled back");
    this.emit("changed");
    return this.summaryOf(this.tplRow(name)!);
  }

  setDefault(name: string): void {
    this.requireTpl(name);
    setMeta(this.db, "default_template", name);
    this.emit("changed");
  }

  /** Edits the current version's recipe in place (metadata only; the image is unchanged). */
  setRecipe(name: string, recipe: string | null): TemplateDetail {
    if (name === BASE_TEMPLATE) throw new DeskhandError("invalid_argument", "The base template has no recipe.");
    const t = this.requireTpl(name);
    const r = recipe && recipe.trim() ? recipe : null;
    this.db.prepare("UPDATE template_versions SET recipe = ? WHERE name = ? AND version = ?").run(r, name, t.current_version);
    this.db.prepare("UPDATE templates SET updated_at = ? WHERE name = ?").run(nowIso(), name);
    this.emit("changed");
    return this.info(name);
  }

  setRebuild(name: string, state: RebuildState | null): void {
    this.db.prepare("UPDATE templates SET rebuild = ? WHERE name = ?").run(state ? JSON.stringify(state) : null, name);
    this.emit("changed");
  }

  async delete(name: string): Promise<void> {
    if (name === BASE_TEMPLATE) throw new DeskhandError("invalid_argument", "The base template is built in and cannot be deleted.");
    this.requireTpl(name);
    if (this.defaultName() === name) throw new DeskhandError("invalid_argument", `"${name}" is the default template; make another template the default first.`);
    this.db.prepare("UPDATE templates SET deleted_at = ? WHERE name = ?").run(nowIso(), name);
    await this.removeUnused(name, new Set());
    this.emit("changed");
  }

  /**
   * Validates a save before anything is quiesced: name rules, and the description rule — a new
   * template needs one; a new version must restate it or explicitly confirm the previous one.
   * An omitted recipe keeps the previous version's; an empty one removes it.
   */
  prepareSave(input: SaveInput): PreparedSave {
    const { name } = input;
    if (!NAME_RE.test(name)) throw new DeskhandError("invalid_argument", "Template names use lowercase letters, digits and dashes (up to 40 characters).");
    if (name === BASE_TEMPLATE) throw new DeskhandError("invalid_argument", "`base` is built in; save under a new name (for example `base-plus-<what you added>`).");
    const t = this.tplRow(name);
    const prev = t ? this.versionRow(name, t.current_version) : undefined;
    let description = input.description;
    if (!description) {
      if (!prev) {
        throw new DeskhandError("invalid_argument", `"${name}" is a new template: pass a description with at least summary and use_when so other agents can find it.`);
      }
      const prevDesc = JSON.parse(prev.description) as TemplateDescription;
      if (!input.confirm_description) {
        throw new DeskhandError(
          "invalid_argument",
          `Every new version must restate or confirm the description. Current description of "${name}": ${JSON.stringify(prevDesc)}. Pass an updated description, or confirm_description: true to keep it unchanged.`,
        );
      }
      description = prevDesc;
    }
    if (!description.summary?.trim() || !description.use_when?.trim()) throw new DeskhandError("invalid_argument", "The description needs a non-empty summary and use_when.");
    const recipe = input.recipe === undefined ? (prev?.recipe ?? null) : input.recipe && input.recipe.trim() ? input.recipe : null;
    return { name, description, recipe, isNew: !prev };
  }

  /** Commits a (quiesced) container as the next version and makes it current. Saves of one template run one at a time. */
  save(opts: SaveOptions): Promise<TemplateSummary> {
    return this.mutex.run(`tpl:${opts.prepared.name}`, () => this.saveNow(opts));
  }

  private async saveNow(opts: SaveOptions): Promise<TemplateSummary> {
    const { name, description, recipe } = opts.prepared;
    const existing = this.db.prepare("SELECT * FROM templates WHERE name = ?").get(name) as { deleted_at: string | null } | undefined;
    const maxV = (this.db.prepare("SELECT MAX(version) AS v FROM template_versions WHERE name = ?").get(name) as { v: number | null }).v ?? 0;
    const version = maxV + 1;
    const tag = `${name}-v${version}`;
    const { image, sizeBytes } = await this.runtime.commit(opts.containerId, {
      repo: this.repo,
      tag,
      labels: {
        "deskhand.template": name,
        "deskhand.template-version": String(version),
        "deskhand.base-version": opts.base.version,
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
          `INSERT INTO template_versions (name, version, image, created_at, saved_by, by_agent, base_version, base_image_id, recipe, description,
             logged_in_sites, extensions, packages, manifest_notes, saved_from, rebuilt_from, size_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          name,
          version,
          image,
          now,
          opts.savedBy,
          opts.byAgent ? 1 : 0,
          opts.base.version,
          opts.base.imageId,
          recipe,
          JSON.stringify(description),
          JSON.stringify(opts.manifest.loggedInSites),
          JSON.stringify(opts.manifest.extensions),
          JSON.stringify(opts.manifest.packages),
          JSON.stringify(opts.manifest.notes),
          opts.savedFrom ? JSON.stringify(opts.savedFrom) : null,
          opts.rebuiltFrom ?? null,
          sizeBytes,
        );
    })();
    this.log.info({ template: name, version, image, sites: opts.manifest.loggedInSites, byAgent: opts.byAgent }, "template saved");
    await this.prune(name);
    this.emit("changed");
    return this.summaryOf(this.tplRow(name)!);
  }

  /** Keeps the newest DESKHAND_TEMPLATE_VERSIONS versions plus the current one and any a desktop still uses. */
  async prune(name: string): Promise<void> {
    const t = this.tplRow(name);
    if (!t || name === BASE_TEMPLATE) return;
    const versions = this.versionRows(name);
    const keep = new Set(versions.slice(-this.cfg.templateVersions).map((v) => v.version));
    keep.add(t.current_version);
    await this.removeUnused(name, keep);
  }

  async pruneAll(): Promise<void> {
    for (const n of this.names()) await this.prune(n).catch((e) => this.log.warn({ template: n, err: (e as Error).message }, "template prune failed"));
    // Deleted templates whose versions were still in use when they were deleted.
    const deleted = this.db.prepare("SELECT DISTINCT v.name FROM template_versions v JOIN templates t ON t.name = v.name WHERE t.deleted_at IS NOT NULL AND v.removed_at IS NULL").all() as Array<{ name: string }>;
    for (const d of deleted) await this.removeUnused(d.name, new Set()).catch(() => undefined);
  }

  private async removeUnused(name: string, keep: Set<number>): Promise<void> {
    for (const v of this.versionRows(name)) {
      if (keep.has(v.version) || this.inUse(name, v.version) > 0 || (name === BASE_TEMPLATE && v.version === 1)) continue;
      let removed: boolean | void = true;
      try {
        removed = await this.runtime.removeImage(v.image);
      } catch (e) {
        this.log.warn({ err: (e as Error).message, image: v.image }, "could not remove old template image");
        continue;
      }
      if (removed === false) {
        this.log.info({ image: v.image }, "template image still used by a container; keeping it for now");
        continue;
      }
      this.db.prepare("UPDATE template_versions SET removed_at = ? WHERE name = ? AND version = ?").run(nowIso(), name, v.version);
      this.log.info({ template: name, version: v.version, image: v.image }, "removed old template version");
    }
  }
}
