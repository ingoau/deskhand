/**
 * Opt-in hardware for desktops (phase 6): per-desktop memory/CPU caps bounded by
 * DESKHAND_DESKTOP_MAX_MEMORY / DESKHAND_DESKTOP_MAX_CPUS, and /dev/kvm passthrough.
 *
 * KVM availability is detected on the Docker host (the manager may run in a container that cannot
 * see the host's /dev) by the runtime's helper and cached. DESKHAND_KVM=off disables it.
 * Inside the desktop the entrypoint (root) gives the container's own /dev/kvm node to the agent's
 * primary group (see images/desktop/rootfs/usr/local/bin/deskhand-entrypoint and docs/design.md).
 */
import type { Logger } from "pino";
import { DeskhandError, type DesktopHardware, type HardwareInfo, type TemplateHardware } from "@deskhand/shared";
import type { Config } from "./config.js";
import type { Runtime } from "./runtime/types.js";
import { parseBytes } from "./util.js";

export interface HardwareRequest {
  memory?: string | number;
  cpus?: number;
  kvm?: boolean;
}

export interface ResolvedHardware extends DesktopHardware {
  /** Things the agent should know (a template default was capped, …). */
  notes: string[];
}

const MIN_MEMORY = 512 * 1024 ** 2;
const MIN_CPUS = 0.25;
/** How long a KVM detection result is reused. */
const KVM_CACHE_MS = 10 * 60_000;

/** 8589934592 → "8 GB", 1610612736 → "1.5 GB", 805306368 → "768 MB" (binary units, as Docker counts). */
export function formatMemory(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${Math.round(gb * 10) / 10} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Short form for agent arguments: 8589934592 → "8g", 805306368 → "768m". */
export function memoryArg(bytes: number): string {
  if (bytes % 1024 ** 3 === 0) return `${bytes / 1024 ** 3}g`;
  return `${Math.round(bytes / 1024 ** 2)}m`;
}

export class HardwareService {
  private kvmCache: { value: boolean; at: number } | null = null;
  private pending: Promise<boolean> | null = null;
  private hostCpus = 0;

  constructor(
    private readonly cfg: Config,
    private readonly runtime: Runtime,
    private readonly log: Logger,
  ) {}

  setHostCpus(n: number) {
    this.hostCpus = n;
  }

  get defaults(): DesktopHardware {
    return { memoryBytes: this.cfg.desktopMemoryBytes, cpus: this.cfg.desktopCpus, kvm: false };
  }

  /** Synchronous view for descriptions and GET /api/system (KVM from the cache; "unknown" before the first check). */
  info(): HardwareInfo {
    let kvm: HardwareInfo["kvm"];
    if (this.cfg.kvm === "off") kvm = "disabled";
    else if (!this.kvmCache) kvm = "unknown";
    else kvm = this.kvmCache.value ? "available" : "unavailable";
    return {
      defaultMemoryBytes: this.cfg.desktopMemoryBytes,
      defaultCpus: this.cfg.desktopCpus,
      maxMemoryBytes: this.cfg.desktopMaxMemoryBytes,
      maxCpus: this.effectiveMaxCpus(),
      kvm,
    };
  }

  private effectiveMaxCpus(): number {
    return this.hostCpus > 0 ? Math.min(this.cfg.desktopMaxCpus, this.hostCpus) : this.cfg.desktopMaxCpus;
  }

  /** Detects KVM on the Docker host (cached for 10 minutes; errors are not cached). */
  async kvmAvailable(): Promise<boolean> {
    if (this.cfg.kvm === "off") return false;
    if (this.kvmCache && Date.now() - this.kvmCache.at < KVM_CACHE_MS) return this.kvmCache.value;
    this.pending ??= this.runtime
      .kvmAvailable()
      .then((value) => {
        if (this.kvmCache?.value !== value) this.log.info({ kvm: value }, value ? "the Docker host has /dev/kvm" : "the Docker host has no /dev/kvm");
        this.kvmCache = { value, at: Date.now() };
        return value;
      })
      .finally(() => (this.pending = null));
    return this.pending;
  }

  /** Best-effort detection at startup so descriptions can state it. */
  async detect(): Promise<void> {
    if (this.cfg.kvm === "off") return;
    await this.kvmAvailable().catch((e) => this.log.warn({ err: (e as Error).message }, "could not check the Docker host for /dev/kvm"));
  }

  private async requireKvm(why: string): Promise<void> {
    if (this.cfg.kvm === "off") {
      throw new DeskhandError("kvm_unavailable", `KVM is turned off on this deskhand host (DESKHAND_KVM=off)${why}. Start the desktop without kvm, or ask the user to enable it.`);
    }
    let ok: boolean;
    try {
      ok = await this.kvmAvailable();
    } catch (e) {
      if (e instanceof DeskhandError && e.code === "docker_unavailable") throw e;
      throw new DeskhandError("kvm_unavailable", `deskhand could not check the Docker host for /dev/kvm (${(e as Error).message})${why}. Try again, or start the desktop without kvm.`);
    }
    if (!ok) {
      throw new DeskhandError(
        "kvm_unavailable",
        `The deskhand host has no KVM (/dev/kvm is missing on the Docker host: no hardware virtualisation, or it is not enabled)${why}. Start the desktop without kvm; emulators then need software emulation, which is much slower.`,
      );
    }
  }

  parseMemory(v: string | number): number {
    let bytes: number;
    if (typeof v === "number") bytes = v;
    else {
      try {
        bytes = parseBytes(v);
      } catch {
        throw new DeskhandError("invalid_argument", `memory must be a size like "4g" or "4096m", got "${v}".`);
      }
    }
    if (!Number.isFinite(bytes) || bytes <= 0) throw new DeskhandError("invalid_argument", `memory must be a size like "4g" or "4096m", got "${v}".`);
    return bytes;
  }

  private checkMemory(bytes: number, raw: string | number): void {
    const max = this.cfg.desktopMaxMemoryBytes;
    if (bytes > max) {
      throw new DeskhandError(
        "invalid_argument",
        `memory ${typeof raw === "string" ? raw : formatMemory(bytes)} is over this host's per-desktop limit of ${formatMemory(max)} (memory: "${memoryArg(max)}" at most; the user can raise DESKHAND_DESKTOP_MAX_MEMORY).`,
        { maxMemoryBytes: max },
      );
    }
    if (bytes < MIN_MEMORY) throw new DeskhandError("invalid_argument", `memory must be at least 512m, got ${formatMemory(bytes)}.`);
  }

  private checkCpus(cpus: number): void {
    const max = this.effectiveMaxCpus();
    if (!Number.isFinite(cpus) || cpus <= 0) throw new DeskhandError("invalid_argument", `cpus must be a positive number, got ${cpus}.`);
    if (cpus > max) {
      const why = max < this.cfg.desktopMaxCpus ? `the deskhand host has ${max} CPUs` : `the per-desktop limit is ${max} (the user can raise DESKHAND_DESKTOP_MAX_CPUS)`;
      throw new DeskhandError("invalid_argument", `cpus ${cpus} is over this host's limit: ${why}; pass cpus: ${max} at most.`, { maxCpus: max });
    }
    if (cpus < MIN_CPUS) throw new DeskhandError("invalid_argument", `cpus must be at least ${MIN_CPUS}, got ${cpus}.`);
  }

  /**
   * Hardware for a new desktop. Precedence: explicit request > `inherit` (a recreated desktop's own
   * hardware) > the template's recorded hardware > the defaults. Explicit values over the max are an
   * error; template values over the max are capped with a note; KVM must be available either way.
   */
  async resolve(req: HardwareRequest, template: { name: string; hardware: TemplateHardware | null } | null, inherit?: DesktopHardware): Promise<ResolvedHardware> {
    const notes: string[] = [];
    const tpl = inherit ? null : (template?.hardware ?? null);
    let memoryBytes: number;
    if (req.memory !== undefined) {
      memoryBytes = this.parseMemory(req.memory);
      this.checkMemory(memoryBytes, req.memory);
    } else if (inherit) {
      memoryBytes = inherit.memoryBytes;
    } else if (tpl?.memoryBytes) {
      memoryBytes = tpl.memoryBytes;
      if (memoryBytes > this.cfg.desktopMaxMemoryBytes) {
        notes.push(`Template ${template!.name} asks for ${formatMemory(memoryBytes)} of memory; this host allows ${formatMemory(this.cfg.desktopMaxMemoryBytes)} per desktop, so it got that.`);
        memoryBytes = this.cfg.desktopMaxMemoryBytes;
      }
    } else {
      memoryBytes = this.cfg.desktopMemoryBytes;
    }
    let cpus: number;
    if (req.cpus !== undefined) {
      this.checkCpus(req.cpus);
      cpus = req.cpus;
    } else if (inherit) {
      cpus = Math.min(inherit.cpus, this.effectiveMaxCpus());
    } else if (tpl?.cpus) {
      cpus = tpl.cpus;
      const max = this.effectiveMaxCpus();
      if (cpus > max) {
        notes.push(`Template ${template!.name} asks for ${cpus} CPUs; this host allows ${max} per desktop, so it got ${max}.`);
        cpus = max;
      }
    } else {
      cpus = this.cfg.desktopCpus;
    }
    const kvm = req.kvm ?? inherit?.kvm ?? tpl?.kvm ?? false;
    if (kvm) {
      const why = req.kvm === undefined && !inherit && tpl?.kvm ? ` — template ${template!.name} was saved from a desktop with kvm; pass kvm: false to start it without` : "";
      await this.requireKvm(why);
    }
    return { memoryBytes, cpus, kvm, notes };
  }

  /** What a template saved from this desktop records (memory/cpus null when they were the defaults). */
  toTemplate(hw: DesktopHardware): TemplateHardware {
    return {
      kvm: hw.kvm,
      memoryBytes: hw.memoryBytes !== this.cfg.desktopMemoryBytes ? hw.memoryBytes : null,
      cpus: hw.cpus !== this.cfg.desktopCpus ? hw.cpus : null,
    };
  }
}
