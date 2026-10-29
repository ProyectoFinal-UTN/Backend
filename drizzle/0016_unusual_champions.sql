CREATE TYPE "public"."estado_alerta" AS ENUM('activa', 'resuelta');--> statement-breakpoint
CREATE TABLE "alerta" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comercio_id" uuid NOT NULL,
	"producto_id" uuid NOT NULL,
	"movimiento_id" uuid,
	"estado" "estado_alerta" DEFAULT 'activa' NOT NULL,
	"stock_al_generar" integer NOT NULL,
	"umbral_al_generar" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resuelta_en" timestamp
);
--> statement-breakpoint
ALTER TABLE "alerta" ADD CONSTRAINT "alerta_comercio_id_comercio_id_fk" FOREIGN KEY ("comercio_id") REFERENCES "public"."comercio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerta" ADD CONSTRAINT "alerta_producto_id_producto_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."producto"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerta" ADD CONSTRAINT "alerta_movimiento_id_movimiento_id_fk" FOREIGN KEY ("movimiento_id") REFERENCES "public"."movimiento"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerta_producto_activa_uidx" ON "alerta" USING btree ("producto_id") WHERE "alerta"."estado" = 'activa';--> statement-breakpoint
CREATE INDEX "alerta_comercio_estado_idx" ON "alerta" USING btree ("comercio_id","estado");--> statement-breakpoint
CREATE INDEX "alerta_productoId_idx" ON "alerta" USING btree ("producto_id");--> statement-breakpoint
CREATE INDEX "alerta_movimientoId_idx" ON "alerta" USING btree ("movimiento_id");