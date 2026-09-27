CREATE UNIQUE INDEX IF NOT EXISTS idx_situation_room_changes_owner_revision
ON situation_room_changes (owner_id, revision);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS situation_room_yahoo_oauth_states (
  state TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS situation_room_yahoo_tokens (
  owner_id TEXT PRIMARY KEY NOT NULL,
  encrypted_token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
