/**
 * MCP endpoint: Streamable HTTP, stateful sessions (Mcp-Session-Id), bearer-token auth.
 * One low-level SDK Server per session; tool calls go through the ToolRegistry.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpBackend, Principal, SessionInfo } from "./backend.js";
import { AGENT_INSTRUCTIONS } from "./instructions.js";
import { SessionState, ToolRegistry } from "./registry.js";
import { registerTools } from "./tools.js";
import { summarize } from "./describe.js";

interface LiveSession {
  info: SessionInfo;
  transport: StreamableHTTPServerTransport;
  server: Server;
  state: SessionState;
  lastSeen: number;
  inflight: number;
}

export interface McpServiceOptions {
  /** Sessions without requests for this long are ended. */
  sessionTimeoutMs: number;
  sweepIntervalMs?: number;
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

function jsonError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function samePrincipal(a: Principal, b: Principal): boolean {
  if (a.kind === "none" || b.kind === "none") return a.kind === b.kind;
  if (a.kind === "token" && b.kind === "token") return a.tokenId === b.tokenId;
  return a.kind === b.kind;
}

export class McpService {
  readonly registry: ToolRegistry;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    private readonly backend: McpBackend,
    private readonly opts: McpServiceOptions,
  ) {
    this.registry = new ToolRegistry(backend, summarize);
    registerTools(this.registry, () => backend.listTemplates());
    this.unsubscribe = backend.onTemplatesChanged(() => this.notifyToolsChanged());
    this.timer = setInterval(() => void this.sweep(), opts.sweepIntervalMs ?? 30_000);
    this.timer.unref();
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  private createServer(live: () => LiveSession | undefined): Server {
    const server = new Server(
      { name: "deskhand", version: this.backend.version },
      { capabilities: { tools: { listChanged: true } }, instructions: this.backend.instructions ?? AGENT_INSTRUCTIONS },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.registry.list() }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const s = live();
      if (!s) return { content: [{ type: "text", text: "Error (unauthorized): this MCP session has ended; reconnect." }], isError: true };
      const progressToken = request.params._meta?.progressToken;
      s.inflight++;
      s.lastSeen = Date.now();
      try {
        return await this.registry.call(request.params.name, request.params.arguments ?? {}, {
          session: s.info,
          state: s.state,
          signal: extra.signal,
          progress: (progress, total, message) => {
            s.lastSeen = Date.now();
            if (progressToken === undefined) return;
            void extra
              .sendNotification({ method: "notifications/progress", params: { progressToken, progress, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) } })
              .catch(() => undefined);
          },
        });
      } finally {
        s.inflight--;
        s.lastSeen = Date.now();
      }
    });
    return server;
  }

  private async newSession(principal: Principal, clientInfo: { name?: string; version?: string } | undefined, resumeId?: string): Promise<LiveSession> {
    let session: LiveSession | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => resumeId ?? randomUUID(),
      onsessioninitialized: (id) => {
        if (!session) return;
        session.info.id = id;
        this.sessions.set(id, session);
        this.backend.sessionOpened(session.info);
      },
      onsessionclosed: (id) => {
        void this.endSession(id, "deleted");
      },
    });
    const server = this.createServer(() => session);
    session = {
      info: { id: resumeId ?? "", principal, clientName: clientInfo?.name, clientVersion: clientInfo?.version },
      transport,
      server,
      state: new SessionState(),
      lastSeen: Date.now(),
      inflight: 0,
    };
    await server.connect(transport);
    if (resumeId) {
      // Resume a session that outlived a manager restart: mark the transport as initialised
      // with the old id so the client keeps working without re-initialising.
      const inner = (transport as unknown as { _webStandardTransport?: { sessionId?: string; _initialized?: boolean } })._webStandardTransport;
      if (!inner) throw new Error("cannot resume");
      inner.sessionId = resumeId;
      inner._initialized = true;
      this.sessions.set(resumeId, session);
    }
    return session;
  }

  /** Handles GET/POST/DELETE on the MCP endpoint. */
  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    if (this.closed) return jsonError(res, 503, -32000, "deskhand is shutting down");
    if (!this.backend.originAllowed(req.headers)) return jsonError(res, 403, -32000, "Forbidden: cross-origin request");
    const principal = this.backend.authenticate(req.headers.authorization);
    if (!principal) {
      return jsonError(res, 401, -32001, "Unauthorized: pass a deskhand API token as 'Authorization: Bearer <token>'", { "www-authenticate": 'Bearer realm="deskhand"' });
    }
    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    try {
      if (sessionId) {
        let s = this.sessions.get(sessionId);
        if (!s) {
          const known = this.backend.knownSession(sessionId);
          const matches = known && (principal.kind !== "token" || known.tokenId === principal.tokenId);
          if (!matches) return jsonError(res, 404, -32001, "Session not found");
          try {
            s = await this.newSession(principal, undefined, sessionId);
            s.info.id = sessionId;
            this.opts.logger?.info({ session: sessionId }, "resumed MCP session after restart");
          } catch {
            return jsonError(res, 404, -32001, "Session not found");
          }
        }
        if (!samePrincipal(s.info.principal, principal)) return jsonError(res, 404, -32001, "Session not found");
        if (!this.backend.principalActive(principal)) return jsonError(res, 401, -32001, "Unauthorized: token revoked");
        s.lastSeen = Date.now();
        this.backend.sessionTouched(sessionId);
        await s.transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === "POST" && (isInitializeRequest(body) || (Array.isArray(body) && body.some((m) => isInitializeRequest(m))))) {
        const init = (Array.isArray(body) ? body.find((m) => isInitializeRequest(m)) : body) as { params?: { clientInfo?: { name?: string; version?: string } } };
        const s = await this.newSession(principal, init?.params?.clientInfo);
        await s.transport.handleRequest(req, res, body);
        return;
      }
      return jsonError(res, 400, -32000, "Bad Request: missing Mcp-Session-Id (send initialize first)");
    } catch (e) {
      this.opts.logger?.warn({ err: (e as Error).message }, "MCP request failed");
      return jsonError(res, 500, -32603, "Internal error");
    }
  }

  async endSession(id: string, reason: "deleted" | "timeout" | "shutdown"): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    if (reason !== "deleted") await s.transport.close().catch(() => undefined);
    await s.server.close().catch(() => undefined);
    if (reason === "shutdown") return; // keep desktops; the session may resume after restart
    await this.backend.sessionClosed(id, reason).catch((e) => this.opts.logger?.warn({ err: (e as Error).message }, "session cleanup failed"));
  }

  /** Ends sessions idle past the timeout (and not waiting on a long tool call). */
  async sweep(now = Date.now()): Promise<void> {
    for (const [id, s] of this.sessions) {
      if (s.inflight === 0 && now - s.lastSeen > this.opts.sessionTimeoutMs) {
        this.opts.logger?.info({ session: id }, "MCP session idle past timeout; ending it");
        await this.endSession(id, "timeout");
      }
    }
  }

  /** Sends notifications/tools/list_changed to every session (template changes). */
  notifyToolsChanged(): void {
    for (const s of this.sessions.values()) void s.server.sendToolListChanged().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe();
    for (const id of [...this.sessions.keys()]) await this.endSession(id, "shutdown");
  }
}
