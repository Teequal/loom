ALTER TABLE `thread_entities` ADD `role` text DEFAULT 'involved' NOT NULL;--> statement-breakpoint
ALTER TABLE `thread_entities` ADD `secret` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `stakes_level` integer;