CREATE TABLE "producto_proveedor" (
	"comercio_id" uuid NOT NULL,
	"producto_id" uuid NOT NULL,
	"proveedor_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "producto_proveedor_producto_id_proveedor_id_pk" PRIMARY KEY("producto_id","proveedor_id")
);
--> statement-breakpoint
ALTER TABLE "producto_proveedor" ADD CONSTRAINT "producto_proveedor_comercio_id_comercio_id_fk" FOREIGN KEY ("comercio_id") REFERENCES "public"."comercio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producto_proveedor" ADD CONSTRAINT "producto_proveedor_producto_id_producto_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."producto"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "producto_proveedor" ADD CONSTRAINT "producto_proveedor_proveedor_id_proveedor_id_fk" FOREIGN KEY ("proveedor_id") REFERENCES "public"."proveedor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "producto_proveedor_proveedorId_idx" ON "producto_proveedor" USING btree ("proveedor_id");