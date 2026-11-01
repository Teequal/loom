ALTER TABLE `live_entries` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `live_entries` ADD `claimed_at` integer;