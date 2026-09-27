CREATE UNIQUE INDEX IF NOT EXISTS idx_situation_room_changes_owner_revision
ON situation_room_changes (owner_id, revision);
