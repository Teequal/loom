CREATE TABLE `players` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`handle` text NOT NULL,
	`enjoys` text DEFAULT '{}' NOT NULL,
	`personal_lines` text DEFAULT '[]' NOT NULL,
	`table_notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `entities` ADD `player_id` integer REFERENCES players(id) ON DELETE SET NULL;