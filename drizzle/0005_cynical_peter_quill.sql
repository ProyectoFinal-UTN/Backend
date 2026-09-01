ALTER TABLE "stock" ADD COLUMN "comercio_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_comercio_id_comercio_id_fk" FOREIGN KEY ("comercio_id") REFERENCES "public"."comercio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_comercioId_idx" ON "stock" USING btree ("comercio_id");