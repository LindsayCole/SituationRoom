CREATE TABLE `situation_room_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`revision` integer NOT NULL,
	`source` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`before_json` text,
	`after_json` text,
	`metadata_json` text,
	`client_change_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_situation_room_changes_owner_client` ON `situation_room_changes` (`owner_id`,`client_change_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_situation_room_changes_owner_revision` ON `situation_room_changes` (`owner_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_situation_room_changes_owner_created` ON `situation_room_changes` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `situation_room_state` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `situation_room_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`summary_json` text,
	`error_text` text
);
--> statement-breakpoint
CREATE INDEX `idx_situation_room_sync_owner_started` ON `situation_room_sync_runs` (`owner_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `situation_room_yahoo_oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `situation_room_yahoo_tokens` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`encrypted_token` text NOT NULL,
	`updated_at` text NOT NULL
);
