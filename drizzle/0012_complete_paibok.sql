CREATE TABLE `pair_weights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`from_entity_id` integer NOT NULL,
	`to_entity_id` integer NOT NULL,
	`warmth` integer,
	`trust` integer,
	`fear` integer,
	`respect` integer,
	`debt` integer,
	`loyalty` integer,
	`field_meta` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pair_weights_unique` ON `pair_weights` (`from_entity_id`,`to_entity_id`);--> statement-breakpoint
ALTER TABLE `threads` ADD `urgency` integer;