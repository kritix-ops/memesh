CREATE TABLE "staff_password_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_password_resets_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "staff_password_resets" ADD CONSTRAINT "staff_password_resets_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_email_lower_unique" ON "staff" USING btree (lower("email")) WHERE "staff"."email" IS NOT NULL;
