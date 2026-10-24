ALTER TABLE `campaigns` ADD `auto_approve` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `live_entries` ADD `parent_id` integer;--> statement-breakpoint
ALTER TABLE `live_entries` ADD `developments` text DEFAULT '[]' NOT NULL;