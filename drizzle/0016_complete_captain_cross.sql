ALTER TABLE `llm_calls` ADD `cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_calls` ADD `cache_write_tokens` integer DEFAULT 0 NOT NULL;