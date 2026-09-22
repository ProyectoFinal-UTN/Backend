-- HU-12: transferencia de stock entre ubicaciones.
--
-- La tabla es solo el encabezado (origen, destino, quien y por que). El
-- movimiento real son las DOS filas de `movimiento` ligadas por
-- `transferencia_id`, que esta migracion por fin ata con su FK: la columna ya
-- existia desde 0006, declarada sin FK porque la tabla destino no estaba.
--
-- Sobre los datos ya cargados: `transferencia_id` es nullable y hoy esta en
-- NULL en todas las filas del libro, y un ADD CONSTRAINT ... FOREIGN KEY no
-- valida las filas con NULL. Por eso esta migracion no necesita backfill y no
-- puede fallar por datos preexistentes (verificado antes de aplicar con
-- `SELECT count(*) FROM movimiento WHERE transferencia_id IS NOT NULL`).
--
-- El enum `tipo_movimiento` no se toca: ya trae 'transferencia' desde 0006,
-- declarado por adelantado justamente para evitar el ALTER TYPE de hoy.
CREATE TABLE "transferencia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comercio_id" uuid NOT NULL,
	"ubicacion_origen_id" uuid NOT NULL,
	"ubicacion_destino_id" uuid NOT NULL,
	"usuario_id" text NOT NULL,
	"motivo" varchar(255),
	"fecha" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transferencia_ubicaciones_distintas_check" CHECK ("transferencia"."ubicacion_origen_id" <> "transferencia"."ubicacion_destino_id")
);
--> statement-breakpoint
ALTER TABLE "transferencia" ADD CONSTRAINT "transferencia_comercio_id_comercio_id_fk" FOREIGN KEY ("comercio_id") REFERENCES "public"."comercio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transferencia" ADD CONSTRAINT "transferencia_ubicacion_origen_id_ubicacion_id_fk" FOREIGN KEY ("ubicacion_origen_id") REFERENCES "public"."ubicacion"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transferencia" ADD CONSTRAINT "transferencia_ubicacion_destino_id_ubicacion_id_fk" FOREIGN KEY ("ubicacion_destino_id") REFERENCES "public"."ubicacion"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transferencia" ADD CONSTRAINT "transferencia_usuario_id_user_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transferencia_comercioId_idx" ON "transferencia" USING btree ("comercio_id");--> statement-breakpoint
ALTER TABLE "movimiento" ADD CONSTRAINT "movimiento_transferencia_id_transferencia_id_fk" FOREIGN KEY ("transferencia_id") REFERENCES "public"."transferencia"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "movimiento_transferenciaId_idx" ON "movimiento" USING btree ("transferencia_id");