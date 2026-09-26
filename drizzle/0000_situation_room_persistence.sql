CREATE TABLE IF NOT EXISTS situation_room_state (
  owner_id TEXT PRIMARY KEY NOT NULL,
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_situation_room_changes_owner_client
ON situation_room_changes (owner_id, client_change_id)
WHERE client_change_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_situation_room_changes_owner_created
ON situation_room_changes (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS situation_room_sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  summary_json TEXT,
  error_text TEXT
);

CREATE INDEX IF NOT EXISTS idx_situation_room_sync_owner_started
ON situation_room_sync_runs (owner_id, started_at DESC);
