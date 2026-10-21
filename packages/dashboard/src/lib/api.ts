/**
 * Thin client for the manager's HTTP API. Every route used here is listed in ../../API.md.
 * Auth is the session cookie (same origin), so requests just send credentials.
 */
import type {
  ApiToken,
  CreateDesktopRequest,
  DesktopSummary,
  ErrorBody,
  Lock,
  LogEntry,
  SystemSummary,
  TemplateDescription,
  TemplateDetail,
  TemplateSummary,
} from "@deskhand/shared";
import { url } from "./base";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {};
/** Called (once per burst) whenever a request comes back 401. The app routes to /login. */
export function setUnauthorizedHandler(fn: UnauthorizedHandler) {
  onUnauthorized = fn;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const e = (body as Partial<ErrorBody> | undefined)?.error;
  if (e && typeof e.code === "string") return new ApiError(res.status, e.code, e.message ?? res.statusText, e.details);
  return new ApiError(res.status, res.status === 401 ? "unauthorized" : "internal", `${res.status} ${res.statusText}`.trim());
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Don't trigger the global 401 handler (used by the login page itself). */
  noAuthRedirect?: boolean;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url(path), {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    credentials: "same-origin",
    signal: opts.signal,
  });
  if (!res.ok) {
    const err = await parseError(res);
    if (res.status === 401 && !opts.noAuthRedirect) onUnauthorized();
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---- response shapes for routes not (yet) in packages/shared ------------------------------------

/** POST/DELETE /api/desktops/:id/lock */
export interface LockResult {
  generation: number;
  lock: Lock | null;
}

/** POST /api/tokens */
export interface CreatedToken {
  token: ApiToken;
  /** The secret, shown once. */
  secret: string;
}

/** POST /api/desktops/:id/save-as-template */
export interface SaveTemplateRequest {
  name: string;
  /** Required for a new template; for a new version restate it, or send confirm_description to keep the current one. */
  description?: TemplateDescription;
  confirm_description?: boolean;
}
export interface SaveTemplateResult {
  template: TemplateSummary;
  version: number;
  /** Notes from the save (quiesce, manifest), phase 4. */
  notes?: string[];
}

export interface UploadResult {
  path: string;
  bytes: number;
}

const enc = encodeURIComponent;

export const api = {
  system: () => request<SystemSummary>("api/system"),

  desktops: () => request<{ desktops: DesktopSummary[] }>("api/desktops").then((r) => r.desktops),
  desktop: (id: string) => request<DesktopSummary>(`api/desktops/${enc(id)}`),
  createDesktop: (body: CreateDesktopRequest) => request<DesktopSummary>("api/desktops", { method: "POST", body }),
  killDesktop: (id: string) => request<void>(`api/desktops/${enc(id)}`, { method: "DELETE" }),
  stopDesktop: (id: string) => request<DesktopSummary>(`api/desktops/${enc(id)}/stop`, { method: "POST" }),
  startDesktop: (id: string) => request<DesktopSummary>(`api/desktops/${enc(id)}/start`, { method: "POST" }),
  setPersistent: (id: string, persistent: boolean) =>
    request<DesktopSummary>(`api/desktops/${enc(id)}/persistent`, { method: "POST", body: { persistent } }),
  takeOver: (id: string) => request<LockResult>(`api/desktops/${enc(id)}/lock`, { method: "POST", body: {} }),
  handBack: (id: string, note: string | null) =>
    request<LockResult>(`api/desktops/${enc(id)}/lock`, { method: "DELETE", body: { note } }),
  /** Dismiss a request_human flag without taking over; the agent's request_human returns "dismissed" with the note. */
  dismissAttention: (id: string, note: string | null) =>
    request<DesktopSummary>(`api/desktops/${enc(id)}/attention`, { method: "DELETE", body: { note } }),
  saveAsTemplate: (id: string, body: SaveTemplateRequest) =>
    request<SaveTemplateResult>(`api/desktops/${enc(id)}/save-as-template`, { method: "POST", body }),
  uploadFile: (id: string, file: File, path: string) => {
    const form = new FormData();
    form.set("path", path);
    form.set("file", file, file.name);
    return request<UploadResult>(`api/desktops/${enc(id)}/files`, { method: "POST", body: form });
  },
  /** Plain URL: the browser downloads it (cookie auth). */
  fileUrl: (id: string, path: string) => url(`api/desktops/${enc(id)}/files?path=${enc(path)}`),

  log: (id: string, opts: { before?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.before != null) q.set("before", String(opts.before));
    q.set("limit", String(opts.limit ?? 50));
    return request<{ entries: LogEntry[] }>(`api/desktops/${enc(id)}/log?${q}`).then((r) => r.entries);
  },
  thumbnailUrl: (id: string, bust?: number) => url(`api/desktops/${enc(id)}/thumbnail${bust ? `?t=${bust}` : ""}`),
  screenshotUrl: (logId: number, thumb = false) => url(`api/log/${logId}/screenshot${thumb ? "?thumb=1" : ""}`),

  templates: () => request<{ templates: TemplateSummary[] }>("api/templates").then((r) => r.templates),
  template: (name: string) => request<TemplateDetail>(`api/templates/${enc(name)}`),
  rollbackTemplate: (name: string, version: number) =>
    request<TemplateDetail>(`api/templates/${enc(name)}/rollback`, { method: "POST", body: { version } }),
  deleteTemplate: (name: string) => request<void>(`api/templates/${enc(name)}`, { method: "DELETE" }),
  /** Edit the current version's recipe in place (null removes it). */
  setTemplateRecipe: (name: string, recipe: string | null) =>
    request<TemplateDetail>(`api/templates/${enc(name)}/recipe`, { method: "PUT", body: { recipe } }),
  /** Replay the recipe on the current base image; waits for the new version. */
  rebuildTemplate: (name: string) =>
    request<{ template: TemplateSummary; version: number }>(`api/templates/${enc(name)}/rebuild`, { method: "POST", body: {} }),
  setDefaultTemplate: (name: string) => request<TemplateDetail>(`api/templates/${enc(name)}/default`, { method: "POST" }),

  tokens: () => request<{ tokens: ApiToken[] }>("api/tokens").then((r) => r.tokens),
  createToken: (name: string) => request<CreatedToken>("api/tokens", { method: "POST", body: { name } }),
  revokeToken: (id: string) => request<void>(`api/tokens/${enc(id)}`, { method: "DELETE" }),

  login: (token: string) => request<void>("auth/login", { method: "POST", body: { token }, noAuthRedirect: true }),
  logoutAll: () => request<void>("auth/logout-all", { method: "POST", noAuthRedirect: true }),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
