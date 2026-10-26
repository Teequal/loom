CREATE TABLE `testers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`owner` integer DEFAULT false NOT NULL,
	`cap_usd` real DEFAULT 2 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `testers_code_unique` ON `testers` (`code`);--> statement-breakpoint
ALTER TABLE `campaigns` ADD `tester_id` integer;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `tester_id` integer;