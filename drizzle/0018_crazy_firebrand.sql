ALTER TABLE `campaigns` ADD `learn` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `learn_from` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `live_entries` ADD `votes` text DEFAULT '{}' NOT NULL;