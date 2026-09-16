CREATE TABLE "ubicacion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comercio_id" uuid NOT NULL,
	"nombre" varchar(100) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ubicacion" ADD CONSTRAINT "ubicacion_comercio_id_comercio_id_fk" FOREIGN KEY ("comercio_id") REFERENCES "public"."comercio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ubicacion_comercioId_nombre_uidx" ON "ubicacion" USING btree ("comercio_id","nombre");--> statement-breakpoint
CREATE INDEX "ubicacion_comercioId_idx" ON "ubicacion" USING btree ("comercio_id");