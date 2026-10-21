import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

/** Append-only. Each entry runs once, in order, tracked by PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE UNIQUE INDEX api_tokens_active_name ON api_tokens(name) WHERE revoked_at IS NULL;

  CREATE TABLE login_codes (
    hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE TABLE web_sessions (
    hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT,
    via TEXT NOT NULL
  );

  CREATE TABLE mcp_sessions (
    id TEXT PRIMARY KEY,
    token_id TEXT,
    actor TEXT NOT NULL,
    client_name TEXT,
    client_version TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    closed_at TEXT,
    close_reason TEXT
  );

  CREATE TABLE desktops (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    container_id TEXT,
    session_id TEXT,
    session_label TEXT,
    session_index INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    template TEXT NOT NULL,
    template_version INTEGER NOT NULL,
    image TEXT NOT NULL,
    persistent INTEGER NOT NULL DEFAULT 0,
    mounts TEXT NOT NULL DEFAULT '[]',
    screen_w INTEGER NOT NULL,
    screen_h INTEGER NOT NULL,
    daemon_key TEXT NOT NULL,
    status TEXT NOT NULL,
    stop_reason TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    stopped_at TEXT,
    last_activity_at TEXT,
    removed_at TEXT,
    remove_reason TEXT,
    attention TEXT,
    last_action TEXT,
    error TEXT
  );
  CREATE INDEX desktops_session ON desktops(session_id);

  CREATE TABLE action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    desktop_id TEXT NOT NULL,
    at TEXT NOT NULL,
    tool TEXT NOT NULL,
    args TEXT,
    summary TEXT NOT NULL,
    outcome TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    actor TEXT,
    session TEXT,
    duration_ms INTEGER,
    overlays TEXT NOT NULL DEFAULT '[]',
    shot INTEGER NOT NULL DEFAULT 0,
    full_pruned INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX action_log_desktop ON action_log(desktop_id, id);
  CREATE INDEX action_log_at ON action_log(at);

  CREATE TABLE templates (
    name TEXT PRIMARY KEY,
    current_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE template_versions (
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    image TEXT NOT NULL,
    created_at TEXT NOT NULL,
    saved_by TEXT,
    by_agent INTEGER NOT NULL DEFAULT 0,
    base_version TEXT NOT NULL,
    recipe TEXT,
    description TEXT NOT NULL,
    logged_in_sites TEXT NOT NULL DEFAULT '[]',
    extensions TEXT NOT NULL DEFAULT '[]',
    packages TEXT NOT NULL DEFAULT '[]',
    size_bytes INTEGER,
    removed_at TEXT,
    PRIMARY KEY (name, version)
  );

  CREATE TABLE template_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    note TEXT NOT NULL,
    by TEXT
  );
  CREATE INDEX template_feedback_name ON template_feedback(name, id);
  `,
  // Phase 4 (templates): manifests, base tracking, rebuilds, feedback sessions.
  `
  ALTER TABLE template_versions ADD COLUMN base_image_id TEXT;
  ALTER TABLE template_versions ADD COLUMN saved_from TEXT;
  ALTER TABLE template_versions ADD COLUMN rebuilt_from INTEGER;
  ALTER TABLE template_versions ADD COLUMN manifest_notes TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE template_feedback ADD COLUMN session TEXT;
  ALTER TABLE templates ADD COLUMN rebuild TEXT;
  `,
  // Phase 6 (opt-in hardware): per-desktop memory/CPU caps and KVM; hardware recorded with template versions.
  `
  ALTER TABLE desktops ADD COLUMN memory_bytes INTEGER;
  ALTER TABLE desktops ADD COLUMN cpus REAL;
  ALTER TABLE desktops ADD COLUMN kvm INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE template_versions ADD COLUMN hardware TEXT;
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: DB): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return MIGRATIONS.length;
}

export function getMeta(db: DB, key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
