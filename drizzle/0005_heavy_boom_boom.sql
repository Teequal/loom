ALTER TABLE `state_changes` ADD `batch` text;--> statement-breakpoint
ALTER TABLE `state_changes` ADD `thread_id` integer REFERENCES threads(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `state_changes` ADD `undone_at` text;