-- HU-12, correccion de review: indices para las FK de `transferencia` hacia
-- `ubicacion`.
--
-- Esas FK son ON DELETE RESTRICT, asi que cada DELETE /api/ubicaciones/:id
-- (HU-8) hace que Postgres busque transferencias que la referencien; sin
-- indice, es un scan de la tabla entera. Es el mismo motivo por el que
-- `movimiento` tiene `movimiento_ubicacionId_idx`.
--
-- Va en una migracion aparte y no editando 0010 porque 0010 ya estaba aplicada
-- en la base compartida. `db:migrate` solo aplica las migraciones cuyo
-- timestamp (`when` del journal) es posterior al de la ultima aplicada; 0010
-- editada conservaria su timestamp, asi que se salteaba sin error: los indices
-- nunca se habrian creado y el .sql del repo habria dejado de describir lo que
-- hay en la base.
CREATE INDEX "transferencia_ubicacionOrigenId_idx" ON "transferencia" USING btree ("ubicacion_origen_id");--> statement-breakpoint
CREATE INDEX "transferencia_ubicacionDestinoId_idx" ON "transferencia" USING btree ("ubicacion_destino_id");