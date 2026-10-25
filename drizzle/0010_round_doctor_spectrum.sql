CREATE TABLE `option_rejections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer,
	`model` text NOT NULL,
	`moment` text NOT NULL,
	`label` text NOT NULL,
	`reason` text NOT NULL,
	`kept` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
