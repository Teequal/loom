CREATE TABLE `live_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`session_number` integer NOT NULL,
	`moment` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`choice_kind` text,
	`choice_label` text DEFAULT '' NOT NULL,
	`choice` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'asked' NOT NULL,
	`batch` text,
	`summary` text DEFAULT '[]' NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`wrapped` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `direction` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `campaign_id` integer;