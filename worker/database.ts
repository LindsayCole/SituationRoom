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
  const result = await database.prepare(
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN
      ('situation_room_state', 'situation_room_changes', 'situation_room_sync_runs',
       'situation_room_yahoo_tokens', 'situation_room_yahoo_oauth_states')`,
  ).all<{ name: string }>();
  if (result.results.length !== 5) throw new Error("Situation Room D1 migration has not been applied.");
}

export function safeParseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
