/**
 * Additional manager API shapes (request/response bodies) beyond manager.ts.
 * All paths are under DESKHAND_BASE_PATH.
 */
import { z } from "zod";
import { ApiToken, DesktopSummary, LogEntry, TemplateDescription, TemplateDetail, TemplateSummary } from "./manager.js";

/** GET /api/me */
export const Me = z.object({
  /** False when DESKHAND_AUTH=off. */
  auth: z.boolean(),
  /** How this request was authenticated. */
  via: z.enum(["cookie", "token", "admin", "none"]),
  /** Token name, "dashboard" for cookie sessions, "cli" for the admin credential, "anonymous" when auth is off. */
  actor: z.string(),
  version: z.string(),
  basePath: z.string(),
});
export type Me = z.infer<typeof Me>;

/** GET /api/desktops -> { desktops } */
export const DesktopList = z.object({ desktops: z.array(DesktopSummary) });
/** GET /api/desktops/:id/log -> { entries } (newest first) */
export const LogPage = z.object({ entries: z.array(LogEntry) });
/** GET /api/templates -> { templates } */
export const TemplateList = z.object({ templates: z.array(TemplateSummary) });
export { TemplateDetail };

/** POST /api/desktops/:id/persistent */
export const SetPersistentRequest = z.object({ persistent: z.boolean() });
/** POST /api/desktops/:id/title */
export const SetTitleRequest = z.object({ title: z.string().max(200) });
/** DELETE /api/desktops/:id/lock (body optional) */
export const HandbackRequest = z.object({ note: z.string().max(4000).nullable().optional() });
/** POST /api/desktops/:id/save-as-template */
export const SaveTemplateRequest = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  description: TemplateDescription,
  recipe: z.string().optional(),
});
export type SaveTemplateRequest = z.infer<typeof SaveTemplateRequest>;
/** POST /api/templates/:name/rollback */
export const RollbackRequest = z.object({ version: z.number().int().positive() });

/** POST /api/tokens {name} -> the token value is returned once and never again. */
export const CreateTokenRequest = z.object({ name: z.string().min(1).max(64).regex(/^[A-Za-z0-9._@-]+$/) });
export const CreateTokenResponse = z.object({ token: ApiToken, secret: z.string() });
export type CreateTokenResponse = z.infer<typeof CreateTokenResponse>;
export const TokenList = z.object({ tokens: z.array(ApiToken) });

/** POST /auth/login: either an API token or a login-link code. Sets the session cookie. */
export const LoginRequest = z.object({ token: z.string().optional(), code: z.string().optional() });

/** POST /api/login-links -> a fresh one-time dashboard login link (5 minutes, single use). */
export const LoginLinkResponse = z.object({ url: z.string(), expiresAt: z.string() });

/** Daemon GET /cursor (not in daemon.ts originally). */
