CREATE TABLE `effects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`name` text NOT NULL,
	`source_entity_id` integer,
	`source_thread_id` integer,
	`trigger` text NOT NULL,
	`applies_to` text NOT NULL,
	`applies_to_list` text DEFAULT '[]' NOT NULL,
	`check` text DEFAULT '' NOT NULL,
	`on_fail` text DEFAULT '' NOT NULL,
	`on_success` text DEFAULT '' NOT NULL,
	`escalation` text DEFAULT '' NOT NULL,
	`duration` text DEFAULT '' NOT NULL,
	`rule` text DEFAULT '' NOT NULL,
	`secret` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `campaigns` ADD `rule_toggles` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `entities` ADD `parent_id` integer REFERENCES entities(id) ON DELETE SET NULL;--> statement-breakpoint
UPDATE `entities` SET `parent_id` = `parent_location_id` WHERE `parent_location_id` IS NOT NULL;