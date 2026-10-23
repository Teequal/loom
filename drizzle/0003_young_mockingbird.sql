CREATE TABLE `key_moments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`session_id` integer,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`tone` text DEFAULT 'other' NOT NULL,
	`callback` text DEFAULT '' NOT NULL,
	`entity_ids` text DEFAULT '[]' NOT NULL,
	`thread_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'key' NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `state_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`session_id` integer,
	`subject` text NOT NULL,
	`entity_id` integer,
	`kind` text NOT NULL,
	`field` text DEFAULT '' NOT NULL,
	`before` text,
	`after` text,
	`source` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE set null
);
