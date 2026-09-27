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
  schemaReady ??= verifySchema(database).catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

async function verifySchema(database: D1Database): Promise<void> {
  const required = [
    "situation_room_state", "situation_room_changes", "situation_room_sync_runs",
    "situation_room_revisions", "situation_room_yahoo_tokens", "situation_room_yahoo_oauth_states",
    "idx_situation_room_changes_owner_client", "idx_situation_room_changes_owner_created",
    "idx_situation_room_changes_owner_revision", "idx_situation_room_sync_owner_started",
    "idx_situation_room_revisions_owner_created",
  ];
  const present = async () => new Set((await database.prepare(
    `SELECT name FROM sqlite_schema WHERE name IN (${required.map(() => "?").join(",")})`,
  ).bind(...required).all<{ name: string }>()).results.map((row) => row.name));

  const current = await present();
  if (required.every((name) => current.has(name))) return;
  for (const sql of [initialMigration, revisionIndexMigration, snapshotMigration, yahooMigration]) {
    for (const statement of sql.replaceAll("--> statement-breakpoint", "").split(";").map((part) => part.trim()).filter(Boolean)) {
      await database.prepare(statement).run();
    }
  }
  const updated = await present();
  if (!required.every((name) => updated.has(name)))
    throw new Error("Situation Room D1 migration is incomplete.");
}
export function safeParseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
import initialMigration from "../drizzle/0000_situation_room_persistence.sql?raw";
import revisionIndexMigration from "../drizzle/0001_change_revision_uniqueness.sql?raw";
import snapshotMigration from "../drizzle/0002_revision_snapshots.sql?raw";
import yahooMigration from "../drizzle/0003_yahoo_auth_and_history.sql?raw";
