CREATE TABLE "proveedor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comercio_id" uuid NOT NULL,
	"nombre" varchar(150) NOT NULL,
	"contacto" varchar(150),
	"telefono" varchar(40),
	"correo" varchar(255),
	"rubro" varchar(100),
	"condiciones_pago" varchar(255),
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proveedor" ADD CONSTRAINT "proveedor_comercio_id_comercio_id_fk" FOREIGN KEY ("comercio_id") REFERENCES "public"."comercio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proveedor_comercioId_idx" ON "proveedor" USING btree ("comercio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proveedor_comercio_nombre_uidx" ON "proveedor" USING btree ("comercio_id",lower("nombre")) WHERE "proveedor"."activo" = true;--> statement-breakpoint
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_proveedor_id_proveedor_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedor"("id") ON DELETE restrict ON UPDATE no action;