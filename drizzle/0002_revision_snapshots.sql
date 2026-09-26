CREATE TABLE IF NOT EXISTS situation_room_revisions (
  owner_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  change_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_situation_room_revisions_owner_created
ON situation_room_revisions (owner_id, created_at DESC);
