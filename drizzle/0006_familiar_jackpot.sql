-- Limpieza previa: en la base quedo una tabla `movimiento` huerfana de una
-- migracion de HU-9 que despues se borro del repo. No la crea ninguna
-- migracion de `drizzle/`, le falta la FK a `producto` y tiene columnas que no
-- estan en el DER (`nota`), asi que no se puede converger con ALTER a la forma
-- que necesita HU-13. Esta vacia (0 filas), de modo que el DROP no pierde
-- datos y deja la tabla definida por src/db/schema.js como unica version.
DROP TABLE IF EXISTS "movimiento";--> statement-breakpoint
CREATE TYPE "public"."tipo_movimiento" AS ENUM('compra', 'venta', 'ajuste', 'merma', 'transferencia');--> statement-breakpoint
CREATE TABLE "movimiento" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comercio_id" uuid NOT NULL,
	"producto_id" uuid NOT NULL,
	"ubicacion_id" uuid NOT NULL,
	"usuario_id" text NOT NULL,
	"tipo" "tipo_movimiento" NOT NULL,
	"cantidad" integer NOT NULL,
	"proveedor_id" uuid,
	"transferencia_id" uuid,
	"fecha" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_comercio_id_comercio_id_fk" FOREIGN KEY ("comercio_id") REFERENCES "public"."comercio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_producto_id_producto_id_fk" FOREIGN KEY ("producto_id") REFERENCES "public"."producto"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_ubicacion_id_ubicacion_id_fk" FOREIGN KEY ("ubicacion_id") REFERENCES "public"."ubicacion"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_usuario_id_user_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "movimiento_comercioId_idx" ON "movimiento" USING btree ("comercio_id");--> statement-breakpoint
CREATE INDEX "movimiento_producto_ubicacion_idx" ON "movimiento" USING btree ("producto_id","ubicacion_id");--> statement-breakpoint
CREATE INDEX "movimiento_ubicacionId_idx" ON "movimiento" USING btree ("ubicacion_id");--> statement-breakpoint
CREATE INDEX "movimiento_fecha_idx" ON "movimiento" USING btree ("fecha");