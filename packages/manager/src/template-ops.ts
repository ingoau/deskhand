/**
 * Template operations that need desktops: the save pipeline (quiesce → manifest → commit) and
 * recipe rebuilds on a new base image.
 *
 * Rebuild (plan: "Recipe plus snapshot"): start a desktop from the current base image, run the
 * recipe, quiesce, then carry the snapshot's non-scriptable state over from the old version's
 * image — by default the browser profiles and credential stores under the agent's home
 * (DESKHAND_TEMPLATE_CARRY, see config.ts) — compute the manifest and commit it as a new version
 * (same description and recipe, `rebuiltFrom` = the old version). The build desktop is removed.
 */
import path from "node:path";
import type { Logger } from "pino";
import { DeskhandError, type TemplateDescription, type TemplateSummary } from "@deskhand/shared";
import type { Config } from "./config.js";
import type { Desktop, DesktopService } from "./desktops.js";
import { computeManifest, type Manifest } from "./manifest.js";
import type { Runtime } from "./runtime/types.js";
import { BASE_TEMPLATE, type TemplateService } from "./templates.js";
import { nowIso } from "./util.js";

export interface SaveRequest {
  name: string;
  description?: TemplateDescription;
  confirm_description?: boolean;
  recipe?: string;
}

export interface SaveResult {
  template: TemplateSummary;
  version: number;
  manifest: Manifest;
  notes: string[];
}

interface Ctx {
  cfg: Config;
  desktops: DesktopService;
  templates: TemplateService;
  runtime: Runtime;
  log: Logger;
}

const AGENT_HOME = "/home/agent";

/** Quiesce + manifest + commit. Shared by template_save (MCP) and the dashboard's save-as-template. */
export async function saveDesktopAsTemplate(
  ctx: Ctx,
  desk: Desktop,
  input: SaveRequest,
  savedBy: string,
  byAgent: boolean,
  sessionLabel: string | null = null,
): Promise<SaveResult> {
  const { desktops, templates, runtime, cfg, log } = ctx;
  // Validate (name, description rule) before closing anybody's apps.
  const prepared = templates.prepareSave(input);
  const restart = await desktops.ensureRunning(desk.id);
  const d = desktops.require(desk.id);
  if (!d.containerId) throw new DeskhandError("desktop_stopped");
  const notes: string[] = [];
  if (restart) notes.push(restart);
  try {
    const q = (await desktops.daemon(d).quiesce()) as { notes?: string[]; chromiumClosed?: boolean } | undefined;
    notes.push("Apps were closed and caches, Downloads and /tmp cleared for the snapshot; reopen what you need.");
    for (const n of q?.notes ?? []) if (!/^Kept /.test(n)) notes.push(n);
  } catch (e) {
    if (!(e instanceof DeskhandError && e.code === "not_found")) throw e;
    log.warn({ desktop: d.id }, "daemon has no /quiesce; saving without it");
    notes.push("This desktop's image cannot quiesce; open apps were snapshotted as they are (cookies may not be flushed).");
  }
  const manifest = await computeManifest(runtime, d.containerId, cfg.agentUid, cfg.agentGid);
  const template = await templates.save({
    prepared,
    containerId: d.containerId,
    savedBy,
    byAgent,
    base: templates.baseOf(d.template, d.templateVersion),
    manifest,
    savedFrom: { desktop: d.id, title: d.title, session: sessionLabel },
    hardware: desktops.hardware.toTemplate(d.hardware),
  });
  return { template, version: template.currentVersion, manifest, notes };
}

/** `# deskhand: run-as=root` in the first lines makes the recipe run as root (default: the agent user). */
export function recipeRunsAsRoot(recipe: string): boolean {
  return recipe
    .split("\n")
    .slice(0, 5)
    .some((l) => /^#\s*deskhand:\s*run-as=root\s*$/i.test(l.trim()));
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class TemplateRebuilder {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly queued = new Map<string, Promise<SaveResult>>();

  constructor(private readonly ctx: Ctx) {}

  /** Recipe-backed templates whose current version was built on another base image. */
  outdatedWithRecipe(): string[] {
    const { templates } = this.ctx;
    return templates.names().filter((n) => {
      if (n === BASE_TEMPLATE) return false;
      try {
        const c = templates.current(n);
        return !!c.recipe && templates.isOutdated(c.base);
      } catch {
        return false;
      }
    });
  }

  /** Called at startup: rebuilds every outdated recipe-backed template (skips ones that already failed on this base). */
  autoRebuild(): Promise<unknown> {
    const { templates, cfg, log } = this.ctx;
    if (!cfg.templateAutoRebuild) return Promise.resolve();
    const todo = this.outdatedWithRecipe().filter((n) => {
      const r = templates.get(n).rebuild;
      return !(r?.status === "failed" && r.baseVersion === templates.base.version);
    });
    if (todo.length) log.info({ templates: todo, base: templates.base.version }, "rebuilding recipe-backed templates on the new base image");
    return Promise.allSettled(todo.map((n) => this.rebuild(n, "deskhand (base update)")));
  }

  /** Queues a rebuild (one at a time, so a base update doesn't start many desktops at once). */
  rebuild(name: string, actor: string): Promise<SaveResult> {
    const { templates } = this.ctx;
    const c = templates.current(name); // throws template_not_found
    if (name === BASE_TEMPLATE) throw new DeskhandError("invalid_argument", "The base template is the desktop image itself; there is nothing to rebuild.");
    if (!c.recipe) {
      throw new DeskhandError(
        "invalid_argument",
        `Template "${name}" has no recipe, so it cannot be replayed on a new base. Add one (PUT /api/templates/${name}/recipe or template_save with recipe), or start a desktop from it and save it again.`,
      );
    }
    const existing = this.queued.get(name);
    if (existing) return existing;
    templates.setRebuild(name, { status: "queued", at: nowIso(), baseVersion: templates.base.version, error: null, version: null });
    const p = this.chain.then(() => this.run(name, actor));
    this.chain = p.catch(() => undefined);
    this.queued.set(name, p);
    void p.catch(() => undefined).finally(() => this.queued.delete(name));
    return p;
  }

  private async run(name: string, actor: string): Promise<SaveResult> {
    const { templates, desktops, runtime, cfg, log } = this.ctx;
    const cur = templates.current(name);
    const base = templates.base;
    const recipe = cur.recipe!;
    templates.setRebuild(name, { status: "running", at: nowIso(), baseVersion: base.version, error: null, version: null });
    log.info({ template: name, from: cur.version, base: base.version, actor }, "template rebuild started");
    let d: Desktop | undefined;
    try {
      // Same memory/CPUs as the template records; KVM only when this host has it (recipes install, they rarely need it).
      const hw = cur.hardware;
      const kvm = !!hw?.kvm && (await desktops.hardware.kvmAvailable().catch(() => false));
      d = await desktops.create({
        sessionId: null,
        sessionLabel: null,
        template: BASE_TEMPLATE,
        name: `rebuild template ${name}`,
        actor,
        ...(hw?.memoryBytes ? { memory: Math.min(hw.memoryBytes, cfg.desktopMaxMemoryBytes) } : {}),
        ...(hw?.cpus ? { cpus: Math.min(hw.cpus, desktops.hardware.info().maxCpus) } : {}),
        kvm,
      });
      const cid = d.containerId!;
      const uid = cfg.agentUid;
      const gid = cfg.agentGid;
      const asRoot = recipeRunsAsRoot(recipe);
      const file = "/tmp/deskhand-recipe.sh";
      await runtime.writeFile(cid, file, Buffer.from(recipe), { uid, gid, mode: 0o700 });
      const script = asRoot
        ? `export DEBIAN_FRONTEND=noninteractive DESKHAND_AGENT_HOME=${AGENT_HOME} DISPLAY=:0 HOME=/root; cd /root; bash -e ${file} </dev/null; rc=$?; rm -f ${file}; exit $rc`
        : `set -a; . /run/deskhand/session.env; set +a; cd ${AGENT_HOME}; bash -e ${file} </dev/null; rc=$?; rm -f ${file}; exit $rc`;
      const r = await runtime.exec(cid, ["bash", "-c", script], { user: asRoot ? "root" : `${uid}:${gid}`, timeoutMs: cfg.recipeTimeoutMs });
      if (r.exitCode !== 0) {
        const tail = (r.stderr || r.stdout).trim().split("\n").slice(-15).join("\n");
        throw new DeskhandError("internal", r.timedOut ? `The recipe did not finish within ${Math.round(cfg.recipeTimeoutMs / 60000)} minutes.` : `The recipe failed (exit ${r.exitCode}):\n${tail}`);
      }
      await desktops.daemon(desktops.require(d.id)).quiesce();
      // Carry the snapshot's login state over the freshly built home.
      const carry = cfg.templateCarryPaths.map((p) => path.posix.join(AGENT_HOME, p));
      const prep = async (p: string) => {
        const dir = path.posix.dirname(p);
        const sh = `rm -rf -- ${shq(p)}; mkdir -p -- ${shq(dir)}; d=${shq(dir)}; while [ "$d" != ${AGENT_HOME} ] && [ "$d" != / ]; do chown ${uid}:${gid} "$d"; d=$(dirname "$d"); done`;
        await runtime.exec(cid, ["bash", "-c", sh], { user: "root", timeoutMs: 60_000 });
      };
      const copied = await runtime.copyFromImage(cur.image, carry, cid, prep);
      if (copied.length) await runtime.exec(cid, ["chown", "-R", `${uid}:${gid}`, ...copied], { user: "root", timeoutMs: 120_000 });
      log.info({ template: name, carried: copied }, "carried snapshot state into the rebuilt template");
      const manifest = await computeManifest(runtime, cid, uid, gid);
      manifest.notes.push(`Rebuilt from v${cur.version} on base ${base.version}; carried from the snapshot: ${copied.map((p) => p.replace(`${AGENT_HOME}/`, "~/")).join(", ") || "nothing"}.`);
      const template = await templates.save({
        prepared: { name, description: cur.description, recipe, isNew: false },
        containerId: cid,
        savedBy: actor,
        byAgent: false,
        base,
        manifest,
        savedFrom: { desktop: d.id, title: d.title, session: null },
        rebuiltFrom: cur.version,
        hardware: cur.hardware,
      });
      templates.setRebuild(name, { status: "ok", at: nowIso(), baseVersion: base.version, error: null, version: template.currentVersion });
      log.info({ template: name, version: template.currentVersion }, "template rebuild finished");
      return { template: templates.get(name), version: template.currentVersion, manifest, notes: [] };
    } catch (e) {
      const msg = (e as Error).message;
      log.warn({ template: name, err: msg }, "template rebuild failed");
      templates.setRebuild(name, { status: "failed", at: nowIso(), baseVersion: base.version, error: msg.slice(0, 2000), version: null });
      throw e;
    } finally {
      if (d) await desktops.remove(d.id, "template_build").catch((e) => log.warn({ desktop: d!.id, err: (e as Error).message }, "could not remove rebuild desktop"));
    }
  }
}
