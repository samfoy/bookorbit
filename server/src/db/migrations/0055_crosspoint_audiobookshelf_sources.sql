ALTER TABLE "reading_sessions" DROP CONSTRAINT "reading_sessions_source_chk";--> statement-breakpoint
ALTER TABLE "reading_sessions" ALTER COLUMN "source" SET DATA TYPE varchar(20);--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD CONSTRAINT "reading_sessions_source_chk" CHECK ("reading_sessions"."source" in ('web', 'koreader', 'manual', 'kobo', 'crosspoint', 'audiobookshelf'));