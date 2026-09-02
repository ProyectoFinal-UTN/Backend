CREATE TABLE "producto" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comercio_id" uuid NOT NULL,
	"nombre" varchar(150) NOT NULL,
	"codigo_barras" varchar(64) NOT NULL,
	"categoria" varchar(100) NOT NULL,
	"unidad_medida" varchar(20) NOT NULL,
	"umbral_minimo" integer DEFAULT 0 NOT NULL,
	"activo" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"producto_id" uuid NOT NULL,
	"ubicacion_id" uuid NOT NULL,
	"cantidad" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "producto" ADD CONSTRAINT "producto_comercio_id_comercio_id_fk" FOREIGN KEY ("comercio_id") REFERENCES "public"."comercio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_producto_id_producto_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."producto"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock" ADD CONSTRAINT "stock_ubicacion_id_ubicacion_id_fk" FOREIGN KEY ("ubicacion_id") REFERENCES "public"."ubicacion"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "producto_comercioId_idx" ON "producto" USING btree ("comercio_id");--> statement-breakpoint
CREATE UNIQUE INDEX "producto_comercio_codigoBarras_uidx" ON "producto" USING btree ("comercio_id","codigo_barras");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_producto_ubicacion_uidx" ON "stock" USING btree ("producto_id","ubicacion_id");--> statement-breakpoint
CREATE INDEX "stock_productoId_idx" ON "stock" USING btree ("producto_id");--> statement-breakpoint
CREATE INDEX "stock_ubicacionId_idx" ON "stock" USING btree ("ubicacion_id");