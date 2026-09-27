import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const situationRoomState = sqliteTable("situation_room_state", {
  ownerId: text("owner_id").primaryKey().notNull(),
  stateJson: text("state_json").notNull(),
  revision: integer("revision").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const situationRoomChanges = sqliteTable("situation_room_changes", {
  id: text("id").primaryKey().notNull(),
  ownerId: text("owner_id").notNull(),
  revision: integer("revision").notNull(),
  source: text("source").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  metadataJson: text("metadata_json"),
  clientChangeId: text("client_change_id"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("idx_situation_room_changes_owner_client").on(table.ownerId, table.clientChangeId),
  uniqueIndex("idx_situation_room_changes_owner_revision").on(table.ownerId, table.revision),
  index("idx_situation_room_changes_owner_created").on(table.ownerId, table.createdAt),
]);

export const situationRoomSyncRuns = sqliteTable("situation_room_sync_runs", {
  id: text("id").primaryKey().notNull(),
  ownerId: text("owner_id").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  summaryJson: text("summary_json"),
  errorText: text("error_text"),
}, (table) => [index("idx_situation_room_sync_owner_started").on(table.ownerId, table.startedAt)]);

export const situationRoomRevisions = sqliteTable("situation_room_revisions", {
  ownerId: text("owner_id").notNull(),
  revision: integer("revision").notNull(),
  stateJson: text("state_json").notNull(),
  changeId: text("change_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.revision] }),
  index("idx_situation_room_revisions_owner_created").on(table.ownerId, table.createdAt),
]);

export const situationRoomYahooTokens = sqliteTable("situation_room_yahoo_tokens", {
  ownerId: text("owner_id").primaryKey().notNull(),
  encryptedToken: text("encrypted_token").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const situationRoomYahooOauthStates = sqliteTable("situation_room_yahoo_oauth_states", {
  state: text("state").primaryKey().notNull(),
  ownerId: text("owner_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
