CREATE TABLE "book_physical_copies" (
	"user_id" integer NOT NULL,
	"book_id" integer NOT NULL,
	"acquisition" varchar(20) DEFAULT 'owned' NOT NULL,
	"page_count" integer,
	"current_page" integer DEFAULT 0 NOT NULL,
	"lender" varchar(255),
	"due_on" date,
	"renewals_used" integer DEFAULT 0 NOT NULL,
	"renewal_limit" integer,
	"returned_on" date,
	"binding" varchar(20),
	"shelf_location" varchar(255),
	"acquired_on" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_physical_copies_pkey" PRIMARY KEY("user_id","book_id"),
	CONSTRAINT "bpc_acquisition_chk" CHECK ("book_physical_copies"."acquisition" in ('owned', 'borrowed_library', 'borrowed_personal')),
	CONSTRAINT "bpc_binding_chk" CHECK ("book_physical_copies"."binding" is null or "book_physical_copies"."binding" in ('hardcover', 'paperback', 'mass_market', 'other')),
	CONSTRAINT "bpc_current_page_nonnegative_chk" CHECK ("book_physical_copies"."current_page" >= 0),
	CONSTRAINT "bpc_page_count_positive_chk" CHECK ("book_physical_copies"."page_count" is null or "book_physical_copies"."page_count" > 0),
	CONSTRAINT "bpc_renewals_used_nonnegative_chk" CHECK ("book_physical_copies"."renewals_used" >= 0),
	CONSTRAINT "bpc_due_requires_lender_chk" CHECK ("book_physical_copies"."acquisition" = 'owned' or "book_physical_copies"."lender" is not null)
);
--> statement-breakpoint
ALTER TABLE "reading_attempts" DROP CONSTRAINT "reading_attempts_origin_chk";--> statement-breakpoint
ALTER TABLE "reading_sessions" DROP CONSTRAINT "reading_sessions_source_chk";--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "medium" varchar(20) DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE "book_physical_copies" ADD CONSTRAINT "book_physical_copies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_physical_copies" ADD CONSTRAINT "book_physical_copies_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bpc_book_id_idx" ON "book_physical_copies" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "bpc_user_due_on_idx" ON "book_physical_copies" USING btree ("user_id","due_on") WHERE "book_physical_copies"."due_on" is not null and "book_physical_copies"."returned_on" is null;--> statement-breakpoint
CREATE INDEX "books_library_medium_idx" ON "books" USING btree ("library_id","medium");--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_medium_chk" CHECK ("books"."medium" in ('file', 'physical'));--> statement-breakpoint
ALTER TABLE "reading_attempts" ADD CONSTRAINT "reading_attempts_origin_chk" CHECK ("reading_attempts"."origin" in ('manual', 'bookorbit', 'kobo', 'koreader', 'hardcover', 'migration', 'physical'));--> statement-breakpoint
ALTER TABLE "reading_sessions" ADD CONSTRAINT "reading_sessions_source_chk" CHECK ("reading_sessions"."source" in ('web', 'koreader', 'manual', 'kobo', 'crosspoint', 'audiobookshelf', 'physical'));