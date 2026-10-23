CREATE TABLE `embeddings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` integer NOT NULL,
	`chunk` integer DEFAULT 0 NOT NULL,
	`model` text NOT NULL,
	`text_hash` text NOT NULL,
	`text` text NOT NULL,
	`vector` blob NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embeddings_owner` ON `embeddings` (`owner_type`,`owner_id`,`chunk`,`model`);