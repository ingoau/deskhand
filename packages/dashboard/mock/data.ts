/**
 * In-memory mock of the manager's state, reproducing the prototypes: 8 desktops, a few templates with
 * history, action logs with overlays, tokens. Times are relative to `reset()`. Dev/test only.
 */
import type {
  ApiToken,
  DesktopSummary,
  LogEntry,
  Overlay,
  SystemSummary,
  TemplateDescription,
  TemplateDetail,
  TemplateFeedback,
  TemplateSummary,
  TemplateVersion,
} from "../../shared/src/index.ts";
import { SCREEN, type SceneKind } from "./images.ts";

const S = 1000;
const M = 60 * S;
const HR = 60 * M;
const D = 24 * HR;

export interface MockDesktop extends DesktopSummary {
  scene: SceneKind;
  accent: string;
  /** When a starting desktop becomes running (ms epoch). */
  readyAt?: number;
}

export interface UploadedFile {
  desktopId: string;
  path: string;
  bytes: number;
  at: string;
}

export interface MockState {
  t0: number;
  desktops: Map<string, MockDesktop>;
  templates: Map<string, TemplateDetail>;
  log: LogEntry[];
  nextLogId: number;
  tokens: { token: ApiToken; secret: string }[];
  authRequired: boolean;
  sessions: Set<string>;
  uploads: UploadedFile[];
  logDiskBytes: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

// ---- templates --------------------------------------------------------------------------------

function version(
  t0: number,
  name: string,
  v: number,
  opts: Partial<TemplateVersion> & { ageMs: number; description: TemplateDescription },
): TemplateVersion {
  return {
    version: v,
    image: name === "base" ? "deskhand-desktop:0.1.0" : `deskhand-template:${name}-v${v}`,
    createdAt: iso(t0 - opts.ageMs),
    savedBy: opts.savedBy ?? (name === "base" ? null : "dashboard"),
    byAgent: opts.byAgent ?? false,
    baseVersion: opts.baseVersion ?? "0.1.0",
    hasRecipe: opts.hasRecipe ?? false,
    description: opts.description,
    loggedInSites: opts.loggedInSites ?? [],
    extensions: opts.extensions ?? [],
    packages: opts.packages ?? [],
    sizeBytes: opts.sizeBytes ?? null,
    inUse: opts.inUse ?? 0,
  };
}

function templateFrom(
  name: string,
  versions: TemplateVersion[],
  feedback: TemplateFeedback[],
  extra: { currentVersion?: number; isDefault?: boolean; lastConfirmedAt?: string | null; stale?: boolean; outdatedBase?: boolean; recipe?: string | null; t0: number },
): TemplateDetail {
  const latest = Math.max(...versions.map((v) => v.version));
  const current = extra.currentVersion ?? latest;
  const cur = versions.find((v) => v.version === current)!;
  const newest = versions.find((v) => v.version === latest)!;
  const changedByAgent = versions.some((v) => v.byAgent && extra.t0 - Date.parse(v.createdAt) < D);
  return {
    name,
    currentVersion: current,
    latestVersion: latest,
    description: cur.description,
    loggedInSites: cur.loggedInSites,
    updatedAt: newest.createdAt,
    recentlyChangedByAgent: changedByAgent,
    lastFeedback: feedback[0] ?? null,
    lastConfirmedAt: extra.lastConfirmedAt ?? null,
    stale: extra.stale ?? false,
    outdatedBase: extra.outdatedBase ?? false,
    isDefault: extra.isDefault ?? false,
    versions: [...versions].sort((a, b) => b.version - a.version),
    feedback,
    recipe: extra.recipe ?? null,
  };
}

/** Recompute summary fields after a mutation (rollback, save, default...). */
export function refreshTemplate(t: TemplateDetail, now: number): TemplateDetail {
  const cur = t.versions.find((v) => v.version === t.currentVersion) ?? t.versions[0]!;
  const latest = Math.max(...t.versions.map((v) => v.version));
  return {
    ...t,
    latestVersion: latest,
    description: cur.description,
    loggedInSites: cur.loggedInSites,
    updatedAt: t.versions.reduce((a, v) => (v.createdAt > a ? v.createdAt : a), t.versions[0]!.createdAt),
    recentlyChangedByAgent: t.versions.some((v) => v.byAgent && now - Date.parse(v.createdAt) < D),
    lastFeedback: t.feedback[0] ?? null,
  };
}

function makeTemplates(t0: number): Map<string, TemplateDetail> {
  const baseDesc: TemplateDescription = {
    summary: "Plain Debian desktop with Chromium, no logins",
    use_when: "Anything that needs a clean browser or desktop and no accounts",
    tags: ["base"],
  };
  const base = templateFrom(
    "base",
    [version(t0, "base", 1, { ageMs: 1 * D + 3 * HR, description: baseDesc, savedBy: null, inUse: 3, sizeBytes: 1.31 * 1024 ** 3 })],
    [{ at: iso(t0 - 5 * HR), kind: "ok", note: "clean start, chromium opens fine", by: "claude-laptop", version: 1 }],
    { isDefault: true, lastConfirmedAt: iso(t0 - 5 * HR), t0 },
  );

  const r1: TemplateDescription = {
    summary: "Chromium logged into GitHub as the bot account",
    use_when: "Reviewing PRs in the GitHub web UI",
    not_for: "Anything needing the personal Google account",
    tags: ["github", "web"],
  };
  const r2: TemplateDescription = {
    summary: "Chromium logged into GitHub and Linear as the bot account",
    use_when: "Triaging issues or reviewing PRs in the web UI",
    not_for: "Anything needing the personal Google account",
    setup_notes: "Linear opens to the Triage view; GitHub has the Refined GitHub extension",
    tags: ["github", "linear", "web"],
  };
  const research = templateFrom(
    "research",
    [
      version(t0, "research", 1, { ageMs: 6 * D, description: r1, savedBy: "dashboard", loggedInSites: ["github.com"], hasRecipe: true, packages: ["gh"], sizeBytes: 1.42 * 1024 ** 3 }),
      version(t0, "research", 2, {
        ageMs: 3 * HR,
        description: r2,
        savedBy: "claude-laptop/9f2c",
        byAgent: true,
        loggedInSites: ["github.com", "linear.app"],
        extensions: ["Refined GitHub"],
        hasRecipe: true,
        packages: ["gh", "jq"],
        sizeBytes: 1.47 * 1024 ** 3,
        inUse: 2,
      }),
    ],
    [
      { at: iso(t0 - 40 * M), kind: "ok", note: "Linear triage view loads logged in", by: "claude-laptop", version: 2 },
      { at: iso(t0 - 2 * D), kind: "ok", note: "github login still valid", by: "codex-ci", version: 1 },
    ],
    { lastConfirmedAt: iso(t0 - 40 * M), recipe: "apt-get install -y gh jq\nchromium --install-extension refined-github", t0 },
  );

  const v1: TemplateDescription = {
    summary: "Chromium logged into the Acme supplier portal and SAP Ariba",
    use_when: "Vendor onboarding, purchase orders, invoice uploads",
    not_for: "Payments approval (needs a human)",
    tags: ["vendors", "procurement"],
  };
  const vendor = templateFrom(
    "vendor-portals",
    [
      version(t0, "vendor-portals", 1, { ageMs: 30 * D, description: { ...v1, summary: "Chromium logged into the Acme supplier portal" }, loggedInSites: ["portal.acme-supplies.com"], sizeBytes: 1.38 * 1024 ** 3 }),
      version(t0, "vendor-portals", 2, { ageMs: 21 * D, description: v1, loggedInSites: ["portal.acme-supplies.com", "service.ariba.com"], sizeBytes: 1.4 * 1024 ** 3 }),
      version(t0, "vendor-portals", 3, {
        ageMs: 14 * D,
        description: { ...v1, setup_notes: "Ariba session lasts ~14 days; re-login needs the 2FA phone" },
        loggedInSites: ["portal.acme-supplies.com", "service.ariba.com"],
        extensions: ["uBlock Origin"],
        sizeBytes: 1.41 * 1024 ** 3,
      }),
    ],
    [{ at: iso(t0 - 12 * D), kind: "problem", note: "Ariba login expired, redirected to SSO", by: "t3/onboarding-vendors", version: 3 }],
    { lastConfirmedAt: iso(t0 - 13 * D), stale: true, t0 },
  );

  const o: TemplateDescription = {
    summary: "LibreOffice and Thunderbird with the shared finance mailbox",
    use_when: "Exporting invoices, editing spreadsheets, sending reports from finance@",
    tags: ["office", "mail"],
  };
  const office = templateFrom(
    "office",
    [
      version(t0, "office", 3, { ageMs: 40 * D, baseVersion: "0.0.9", description: o, loggedInSites: ["mail.example.com"], packages: ["libreoffice", "thunderbird"], sizeBytes: 2.1 * 1024 ** 3 }),
      version(t0, "office", 4, { ageMs: 33 * D, baseVersion: "0.0.9", description: o, loggedInSites: ["mail.example.com"], packages: ["libreoffice", "thunderbird", "fonts-crosextra-carlito"], sizeBytes: 2.15 * 1024 ** 3, inUse: 1 }),
      version(t0, "office", 5, {
        ageMs: 9 * D,
        baseVersion: "0.0.9",
        savedBy: "claude-laptop/1b7e",
        byAgent: true,
        description: { ...o, setup_notes: "Calc opens invoices.ods on start" },
        loggedInSites: ["mail.example.com"],
        packages: ["libreoffice", "thunderbird", "fonts-crosextra-carlito", "csvkit"],
        sizeBytes: 2.2 * 1024 ** 3,
      }),
    ],
    [
      { at: iso(t0 - 8 * D), kind: "problem", note: "v5 opens invoices.ods read-only, rolled back to v4", by: "dashboard", version: 5 },
      { at: iso(t0 - 9 * D), kind: "ok", note: "mailbox syncs", by: "claude-laptop", version: 5 },
    ],
    { currentVersion: 4, lastConfirmedAt: iso(t0 - 9 * D), outdatedBase: true, t0 },
  );

  // Phase 4 fields (optional in the contract), as the manager reports them.
  const base4 = { currentBaseVersion: "0.1.0" };
  Object.assign(base, base4, { hasRecipe: false, baseVersion: "0.1.0", extensions: [], staleReason: null, changedByAgentAt: null, rebuild: null });
  Object.assign(research, base4, { hasRecipe: true, baseVersion: "0.1.0", extensions: research.versions.find((v) => v.version === research.currentVersion)?.extensions ?? [], staleReason: null, rebuild: null });
  Object.assign(vendor, base4, { hasRecipe: false, baseVersion: "0.1.0", extensions: ["uBlock Origin"], staleReason: "problem reported: Ariba login expired, redirected to SSO", rebuild: null });
  Object.assign(office, base4, { hasRecipe: false, baseVersion: "0.0.9", extensions: [], staleReason: null, rebuild: null });
  return new Map([base, research, vendor, office].map((t) => [t.name, t]));
}

// ---- desktops ---------------------------------------------------------------------------------

interface DesktopSeed {
  id: string;
  title: string | null;
  session: string | null;
  sessionIndex?: number;
  template: string;
  templateVersion: number;
  scene: SceneKind;
  accent: string;
  startedAgo: number | null;
  createdAgo: number;
  status?: DesktopSummary["status"];
  persistent?: boolean;
  cpu?: number;
  memMb?: number;
}

const SEEDS: DesktopSeed[] = [
  { id: "7f3a", title: "supplier-portal-sign-up", session: "t3/onboarding-vendors", template: "base", templateVersion: 1, scene: "captcha", accent: "#2f6b52", startedAgo: 18 * M, createdAgo: 18 * M + 6 * S, cpu: 3.1, memMb: 820 },
  { id: "2c91", title: "linear-triage", session: "claude-laptop/9f2c", template: "research", templateVersion: 2, scene: "issues", accent: "#5a62d6", startedAgo: 42 * M, createdAgo: 3 * HR, cpu: 11.4, memMb: 1310 },
  { id: "b40e", title: "invoice-export.sub2", session: "claude-laptop/1b7e", sessionIndex: 2, template: "office", templateVersion: 4, scene: "sheet", accent: "#1f6f3c", startedAgo: 65 * M, createdAgo: 2 * HR + 50 * M, cpu: 6.2, memMb: 1540, persistent: true },
  { id: "e1d8", title: "pr-review-212", session: "codex-ci/3a1d", template: "research", templateVersion: 2, scene: "diff", accent: "#2b2d31", startedAgo: 9 * M, createdAgo: 2 * HR + 20 * M, cpu: 14.8, memMb: 1180 },
  { id: "5a77", title: "drag-test-suite", session: "suite/run-118", template: "base", templateVersion: 1, scene: "drag", accent: "#b4520f", startedAgo: 3 * M, createdAgo: 70 * M, cpu: 7.3, memMb: 690 },
  { id: "93fc", title: "move-release-assets", session: "claude-laptop/77d0", template: "base", templateVersion: 1, scene: "files", accent: "#4b4b4e", startedAgo: 27 * M, createdAgo: 50 * M, cpu: 3.6, memMb: 540 },
  { id: "0d2b", title: "docs-screenshots", session: "claude-laptop/0aa3", template: "research", templateVersion: 1, scene: "docs", accent: "#3d2b6e", startedAgo: 2 * HR + 40 * M, createdAgo: 2 * HR + 41 * M, status: "stopped" },
  { id: "c41e", title: null, session: "t3/research-notes", template: "research", templateVersion: 2, scene: "blank", accent: "#2b2d31", startedAgo: null, createdAgo: 4 * S, status: "starting" },
];

function makeDesktop(t0: number, s: DesktopSeed): MockDesktop {
  const status = s.status ?? "running";
  const startedAt = s.startedAgo != null ? iso(t0 - s.startedAgo) : null;
  const stopped = status === "stopped";
  return {
    id: s.id,
    name: `deskhand-${s.id}`,
    title: s.title,
    session: s.session,
    sessionIndex: s.sessionIndex ?? 0,
    template: s.template,
    templateVersion: s.templateVersion,
    status,
    persistent: s.persistent ?? false,
    attention: null,
    lock: null,
    generation: 1,
    lastHandback: null,
    lastAction: null,
    createdAt: iso(t0 - s.createdAgo),
    startedAt,
    stoppedAt: stopped ? iso(t0 - 30 * M) : null,
    lastActivityAt: stopped ? iso(t0 - 60 * M) : startedAt,
    screen: { ...SCREEN },
    mounts: s.id === "93fc" ? [{ path: "/home/inw/releases", write: true }] : [],
    cpuPercent: status === "running" ? (s.cpu ?? 2) : null,
    memoryBytes: status === "running" ? (s.memMb ?? 400) * 1024 * 1024 : null,
    diskBytes: status === "starting" ? null : 180 * 1024 * 1024,
    scene: s.scene,
    accent: s.accent,
    readyAt: status === "starting" ? t0 + 6 * S : undefined,
  };
}

// ---- action log -------------------------------------------------------------------------------

interface Step {
  tool: string;
  args?: unknown;
  summary: string;
  overlays?: Overlay[];
  outcome?: LogEntry["outcome"];
  error?: LogEntry["error"];
  actor?: string;
  durationMs?: number | null;
  /** Seconds before the next step. */
  gap?: number;
  screenshot?: boolean;
}

const pt = (x: number, y: number, label?: string): Overlay => ({ kind: "point", at: [x, y], ...(label ? { label } : {}) });

const click = (x: number, y: number, gap = 14): Step => ({
  tool: "left_click",
  args: { action: "left_click", coordinate: [x, y] },
  summary: `left_click [${x}, ${y}]`,
  overlays: [pt(x, y)],
  durationMs: 420 + ((x * 7 + y) % 380),
  gap,
});
const shot = (gap = 6): Step => ({ tool: "screenshot", args: { action: "screenshot" }, summary: "screenshot", durationMs: 180, gap });
const zoom = (r: [number, number, number, number], gap = 9): Step => ({
  tool: "zoom",
  args: { action: "zoom", region: r },
  summary: `zoom [${r.join(", ")}]`,
  overlays: [{ kind: "region", region: r }],
  durationMs: 260,
  gap,
});
const type = (text: string, gap = 8): Step => ({
  tool: "type",
  args: { action: "type", text },
  summary: `type "${text.length > 24 ? text.slice(0, 23) + "…" : text}"`,
  durationMs: 300 + text.length * 25,
  gap,
});
const key = (k: string, gap = 5): Step => ({ tool: "key", args: { action: "key", text: k }, summary: `key ${k}`, durationMs: 210, gap });
const drag = (from: [number, number], to: [number, number], via: [number, number][] = [], gap = 12): Step => ({
  tool: "left_click_drag",
  args: { action: "left_click_drag", start_coordinate: from, coordinate: to },
  summary: `left_click_drag [${from.join(",")}]→[${to.join(",")}]`,
  overlays: [{ kind: "path", points: [from, ...via, to] }, pt(from[0], from[1])],
  durationMs: 1100,
  gap,
});
const nav = (u: string, gap = 10): Step => ({ tool: "browser_navigate", args: { url: u }, summary: `browser_navigate("${u}")`, durationMs: 1800, gap });
const snapshot = (gap = 7): Step => ({ tool: "browser_snapshot", args: {}, summary: "browser_snapshot()", durationMs: 640, gap, screenshot: false });

function stepsFor(id: string): Step[] {
  switch (id) {
    case "7f3a":
      return [
        { tool: "desktop_start", args: { template: "base", name: "supplier-portal-sign-up" }, summary: 'desktop_start(template="base")', durationMs: 3900, gap: 20, screenshot: false },
        nav("https://portal.acme-supplies.com/register"),
        shot(),
        click(640, 270),
        type("Northwind Traders Pty Ltd"),
        key("Tab"),
        type("ap@northwind.example"),
        click(820, 560, 30),
        shot(),
        nav("https://portal.acme-supplies.com/sign-in"),
        click(640, 470, 2),
        zoom([480, 380, 800, 560], 9),
        {
          tool: "request_human",
          args: { reason: "CAPTCHA on the sign-in page" },
          summary: 'request_human("CAPTCHA…")',
          durationMs: null,
          gap: 0,
        },
      ];
    case "2c91":
      return [
        nav("https://linear.app/acme/team/OPS/triage"),
        snapshot(),
        click(812, 256),
        shot(),
        key("ctrl+k"),
        type("assign to platform"),
        key("Return"),
        click(812, 300),
        { tool: "scroll", args: { action: "scroll", scroll_direction: "down", scroll_amount: 5, coordinate: [640, 480] }, summary: "scroll down 5 [640, 480]", overlays: [pt(640, 480)], durationMs: 380, gap: 6 },
        click(812, 344, 0),
      ];
    case "b40e":
      return [
        { tool: "desktop_exec", args: { command: "libreoffice --calc ~/invoices.ods" }, summary: 'desktop_exec("libreoffice --calc ~/invoices.ods")', durationMs: 2300, gap: 12 },
        shot(),
        click(330, 291),
        drag([330, 291], [890, 651], [[600, 470]], 10),
        key("ctrl+c"),
        { tool: "request_human", args: { reason: "Export dialog asks for the finance share password" }, summary: 'request_human("Export dialog asks…")', durationMs: 31 * 60 * 1000, gap: 2 },
        { tool: "takeover", args: {}, summary: "takeover", actor: "dashboard", durationMs: 40, gap: 30 },
        {
          tool: "left_click",
          args: { action: "left_click", coordinate: [700, 420] },
          summary: "left_click [700, 420]",
          overlays: [pt(700, 420)],
          outcome: "error",
          error: { code: "locked_by_user", message: "The user is controlling this desktop; wait and try again." },
          durationMs: 30_000,
          gap: 60,
          screenshot: false,
        },
        shot(0),
      ];
    case "e1d8":
      return [
        nav("https://github.com/acme/deskhand/pull/212/files"),
        snapshot(),
        { tool: "browser_click", args: { ref: "e214", element: "Viewed checkbox" }, summary: 'browser_click("Viewed checkbox")', overlays: [pt(1150, 236)], durationMs: 10_000, outcome: "unknown", error: { code: "outcome_unknown", message: "The previous action may or may not have happened." }, gap: 14 },
        shot(),
        zoom([60, 300, 700, 520]),
        { tool: "scroll", args: { action: "scroll", scroll_direction: "down", scroll_amount: 10, coordinate: [640, 500] }, summary: "scroll down 10 [640, 500]", overlays: [pt(640, 500)], durationMs: 400, gap: 8 },
        snapshot(0),
      ];
    case "5a77":
      return [
        nav("http://localhost:7000/drag-tests/basic.html"),
        shot(),
        drag([212, 380], [904, 410], [[420, 330], [700, 330]], 10),
        shot(),
        zoom([820, 330, 990, 490]),
        drag([905, 410], [215, 382], [], 10),
        shot(),
        drag([212, 380], [904, 410], [[560, 395]], 0),
      ];
    case "93fc":
      return [
        { tool: "desktop_exec", args: { command: "nautilus /home/inw/releases" }, summary: 'desktop_exec("nautilus /home/inw/releases")', durationMs: 1400, gap: 10 },
        shot(),
        { tool: "ui_tree", args: { window: "Files" }, summary: 'ui_tree("Files")', durationMs: 900, gap: 8, screenshot: false },
        { tool: "double_click", args: { action: "double_click", coordinate: [349, 252] }, summary: "double_click [349, 252]", overlays: [pt(349, 252)], durationMs: 520, gap: 9 },
        drag([529, 252], [140, 360], [], 10),
        shot(),
        { tool: "ui_tree", args: { window: "Files" }, summary: 'ui_tree("Files")', durationMs: 870, gap: 0, screenshot: false },
      ];
    case "0d2b":
      return [
        nav("http://localhost:4173/docs/quickstart"),
        shot(),
        zoom([128, 355, 608, 615]),
        { tool: "file_get", args: { path: "/home/agent/Pictures/quickstart-1.png" }, summary: 'file_get("~/Pictures/quickstart-1.png")', durationMs: 210, gap: 12, screenshot: false },
        shot(0),
      ];
    default:
      return [];
  }
}

function buildLog(t0: number, desktops: Map<string, MockDesktop>): { log: LogEntry[]; nextId: number } {
  const all: LogEntry[] = [];
  let id = 1000;
  // Anchor each desktop's last step at a sensible time before t0.
  const lastAt: Record<string, number> = {
    "7f3a": t0 - 2 * M,
    "2c91": t0 - 20 * S,
    "b40e": t0 - 3 * M,
    "e1d8": t0 - 40 * S,
    "5a77": t0 - 15 * S,
    "93fc": t0 - 50 * S,
    "0d2b": t0 - 60 * M,
  };
  for (const d of desktops.values()) {
    const steps = stepsFor(d.id);
    if (!steps.length) continue;
    // Walk backwards from the last step using each step's gap.
    const times: number[] = new Array(steps.length);
    let t = lastAt[d.id] ?? t0 - M;
    for (let i = steps.length - 1; i >= 0; i--) {
      times[i] = t;
      t -= (steps[i - 1]?.gap ?? 10) * S;
    }
    steps.forEach((s, i) => {
      all.push({
        id: 0,
        desktopId: d.id,
        at: iso(times[i]!),
        tool: s.tool,
        args: s.args ?? {},
        summary: s.summary,
        outcome: s.outcome ?? "ok",
        error: s.error ?? null,
        actor: s.actor ?? (d.session ? d.session.split("/")[0]! : null),
        session: s.actor === "dashboard" ? null : d.session,
        durationMs: s.durationMs ?? null,
        overlays: s.overlays ?? [],
        hasScreenshot: s.screenshot ?? s.tool !== "request_human",
      });
    });
  }
  all.sort((a, b) => a.at.localeCompare(b.at));
  for (const e of all) e.id = ++id;
  return { log: all, nextId: id + 1 };
}

// ---- state ------------------------------------------------------------------------------------

export function createState(opts: { authRequired?: boolean } = {}): MockState {
  const t0 = Date.now();
  const desktops = new Map(SEEDS.map((s) => [s.id, makeDesktop(t0, s)]));
  const { log, nextId } = buildLog(t0, desktops);

  // Last action per desktop from its log.
  for (const e of log) {
    const d = desktops.get(e.desktopId)!;
    d.lastAction = { tool: e.tool, summary: e.summary, at: e.at };
    if (d.status !== "stopped") d.lastActivityAt = e.at;
  }
  const supplier = desktops.get("7f3a")!;
  supplier.attention = { reason: "CAPTCHA on the sign-in page", since: iso(t0 - 2 * M), timeoutAt: iso(t0 + 8 * M) };
  const invoice = desktops.get("b40e")!;
  invoice.lock = { holder: "dashboard", since: iso(t0 - 34 * M), generation: 4 };
  invoice.generation = 4;
  invoice.lastHandback = { note: "unlocked the share for you", at: iso(t0 - 50 * M), generation: 3 };

  return {
    t0,
    desktops,
    templates: makeTemplates(t0),
    log,
    nextLogId: nextId,
    tokens: [
      { token: { id: "tok_1", name: "claude-laptop", createdAt: iso(t0 - 9 * D), lastUsedAt: iso(t0 - 20 * S) }, secret: "dh_claude_laptop_demo" },
      { token: { id: "tok_2", name: "codex-ci", createdAt: iso(t0 - 4 * D), lastUsedAt: iso(t0 - 40 * S) }, secret: "dh_codex_ci_demo" },
      { token: { id: "tok_3", name: "t3", createdAt: iso(t0 - 2 * D), lastUsedAt: iso(t0 - 2 * M) }, secret: "dh_t3_demo" },
    ],
    authRequired: opts.authRequired ?? false,
    sessions: new Set(),
    uploads: [],
    logDiskBytes: Math.round(1.3 * 1024 ** 3),
  };
}

/** Advance time-based transitions (starting -> running). */
export function tick(state: MockState, now = Date.now()) {
  for (const d of state.desktops.values()) {
    if (d.status === "starting" && d.readyAt && now >= d.readyAt) {
      d.status = "running";
      d.startedAt = iso(d.readyAt);
      d.lastActivityAt = d.startedAt;
      d.cpuPercent = 2;
      d.memoryBytes = 380 * 1024 * 1024;
      d.diskBytes = 120 * 1024 * 1024;
      d.readyAt = undefined;
    }
  }
}

export function systemSummary(state: MockState): SystemSummary {
  const running = [...state.desktops.values()].filter((d) => d.status === "running");
  return {
    version: "0.1.0",
    running: running.length,
    maxDesktops: 8,
    // Matches the prototype's "6/8 · 46% · 9.8G" with the default fixture.
    cpuPercent: Math.round(running.reduce((a, d) => a + (d.cpuPercent ?? 0), 0)),
    memoryUsedBytes: Math.round(9.8 * 1024 ** 3 + (running.length - 6) * 400 * 1024 ** 2),
    memoryBudgetBytes: 24 * 1024 ** 3,
    logDiskBytes: state.logDiskBytes,
    auth: state.authRequired,
  };
}

export function publicDesktop(d: MockDesktop): DesktopSummary {
  const { scene: _s, accent: _a, readyAt: _r, ...rest } = d;
  return rest;
}

export function templateSummary(t: TemplateDetail): TemplateSummary {
  const { versions: _v, feedback: _f, recipe: _r, ...rest } = t;
  return rest;
}

export function addLog(state: MockState, e: Omit<LogEntry, "id">): LogEntry {
  const entry = { ...e, id: state.nextLogId++ };
  state.log.push(entry);
  const d = state.desktops.get(e.desktopId);
  if (d) {
    d.lastAction = { tool: e.tool, summary: e.summary, at: e.at };
    d.lastActivityAt = e.at;
  }
  return entry;
}

export function randomId(n = 4): string {
  return Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
}
