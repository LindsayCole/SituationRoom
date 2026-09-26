export interface StateRow {
  owner_id: string;
  state_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ChangeRow {
  id: string;
  revision: number;
  source: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before_json: string | null;
  after_json: string | null;
  metadata_json: string | null;
  client_change_id: string | null;
  created_at: string;
}

export interface SyncRunRow {
  id: string;
  provider: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  summary_json: string | null;
  error_text: string | null;
}

let schemaReady: Promise<void> | null = null;

export function ensureSchema(database: D1Database): Promise<void> {
  schemaReady ??= initializeSchema(database).catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function initializeSchema(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare(`
      CREATE TABLE IF NOT EXISTS situation_room_state (
        owner_id TEXT PRIMARY KEY NOT NULL,
        state_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    database.prepare(`
      CREATE TABLE IF NOT EXISTS situation_room_changes (
        id TEXT PRIMARY KEY NOT NULL,
        owner_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        before_json TEXT,
        after_json TEXT,
        metadata_json TEXT,
        client_change_id TEXT,
        created_at TEXT NOT NULL
      )
    `),
    database.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_situation_room_changes_owner_client
      ON situation_room_changes (owner_id, client_change_id)
      WHERE client_change_id IS NOT NULL
    `),
    database.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_situation_room_changes_owner_revision
      ON situation_room_changes (owner_id, revision)
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_situation_room_changes_owner_created
      ON situation_room_changes (owner_id, created_at DESC)
    `),
    database.prepare(`
      CREATE TABLE IF NOT EXISTS situation_room_revisions (
        owner_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        change_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, revision)
      )
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_situation_room_revisions_owner_created
      ON situation_room_revisions (owner_id, created_at DESC)
    `),
    database.prepare(`
      CREATE TABLE IF NOT EXISTS situation_room_sync_runs (
        id TEXT PRIMARY KEY NOT NULL,
        owner_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        summary_json TEXT,
        error_text TEXT
      )
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS idx_situation_room_sync_owner_started
      ON situation_room_sync_runs (owner_id, started_at DESC)
    `),
  ]);
  await database.prepare("PRAGMA optimize").run();
}

export function safeParseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
