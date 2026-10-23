CREATE TABLE `entity_relations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`from_entity_id` integer NOT NULL,
	`to_entity_id` integer NOT NULL,
	`type` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`strength` integer DEFAULT 0 NOT NULL,
	`secret` integer DEFAULT false NOT NULL,
	`since_session_id` integer,
	`source` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`since_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entity_relations_unique` ON `entity_relations` (`from_entity_id`,`to_entity_id`,`type`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `party_location_id` integer REFERENCES entities(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `in_game_date` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `tone` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `mechanics` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `safety_lines` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `field_meta` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `entities` ADD `status` text;--> statement-breakpoint
ALTER TABLE `entities` ADD `attitude` text;--> statement-breakpoint
ALTER TABLE `entities` ADD `importance` text;--> statement-breakpoint
ALTER TABLE `entities` ADD `last_known_location_id` integer REFERENCES entities(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `entities` ADD `actual_location_id` integer REFERENCES entities(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `entities` ADD `parent_location_id` integer REFERENCES entities(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `entities` ADD `traits` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `entities` ADD `field_meta` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `deadline` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `stakes` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `secret` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `field_meta` text DEFAULT '{}' NOT NULL;