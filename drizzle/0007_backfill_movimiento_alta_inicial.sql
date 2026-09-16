-- Backfill del libro de movimientos para el stock que ya existia (HU-13).
--
-- HU-9 cargaba el stock inicial del alta de productos con un INSERT directo
-- sobre `stock`, sin un MOVIMIENTO detras (quedo anotado como pendiente al
-- cerrar esa HU). Eso rompe el invariante del modelo hibrido:
--
--   STOCK.cantidad = SUM(MOVIMIENTO.cantidad) por (producto, ubicacion)
--
-- De ahora en mas `crearProducto` registra el movimiento junto con el stock
-- (ver aplicarMovimiento en services/movimientos.service.js). Esta migracion
-- se encarga de las filas que ya estaban: crea un movimiento de tipo `ajuste`
-- por cada saldo distinto de cero, fechado con el `created_at` de la fila de
-- stock para que el libro quede cronologicamente honesto.
--
-- Se usa `ajuste` y no un tipo nuevo tipo "alta_inicial": `ajuste` ya significa
-- "la cantidad pasa a ser esta porque asi se declara", y sumar un sexto valor
-- al enum obligaria a contemplarlo en el historial (HU-14) y en las alertas.
--
-- El alta no guardaba quien la hizo, asi que el movimiento se atribuye al
-- propietario del comercio, que es el miembro que siempre existe (lo crea el
-- sign-up de HU-1). El EXISTS descarta comercios sin ningun `member`, donde el
-- subselect daria NULL y chocaria contra el NOT NULL de `usuario_id`.

INSERT INTO "movimiento" ("comercio_id", "producto_id", "ubicacion_id", "usuario_id", "tipo", "cantidad", "fecha")
SELECT s."comercio_id",
       s."producto_id",
       s."ubicacion_id",
       (SELECT m."user_id"
          FROM "member" m
          JOIN "organization" o ON o."id" = m."organization_id"
          JOIN "comercio" c     ON c."organization_id" = o."id"
         WHERE c."id" = s."comercio_id"
         ORDER BY (m."role" = 'propietario') DESC, m."created_at" ASC
         LIMIT 1),
       'ajuste',
       s."cantidad",
       s."created_at"
  FROM "stock" s
 WHERE s."cantidad" <> 0
   AND EXISTS (SELECT 1
                 FROM "member" m
                 JOIN "organization" o ON o."id" = m."organization_id"
                 JOIN "comercio" c     ON c."organization_id" = o."id"
                WHERE c."id" = s."comercio_id");
