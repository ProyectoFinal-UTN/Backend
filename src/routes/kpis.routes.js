import { Router } from "express";
import * as controller from "../controllers/kpis.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth.middleware.js";

const router = Router();

// Todo lo de acá exige sesión. `requireAuth` deja el `comercioId` en `req`,
// que es lo que hace que cada comercio vea solo sus indicadores.
router.use(requireAuth);

/**
 * @openapi
 * /api/kpis:
 *   get:
 *     summary: KPIs principales del dashboard, filtrables por período (HU-22, HU-23)
 *     description: >
 *       Estado del stock, rotación de productos y compras por proveedor, en
 *       una sola respuesta para que el dashboard cargue con un único pedido.
 *
 *
 *       **Período (HU-23).** Dos formas de pedirlo, y son EXCLUYENTES
 *       (mandar las dos da 400):
 *
 *
 *       1. `dias` — la ventana móvil que termina hoy. Es el default.
 *
 *       2. `desde` + `hasta` — un rango absoluto, con los DOS extremos
 *       INCLUSIVE. Ambos o ninguno. Es la misma convención que
 *       `GET /api/reportes` (HU-25), así que el cliente usa un solo helper de
 *       rango para los dos endpoints.
 *
 *
 *       Los presets de día, semana y mes los resuelve el Frontend a instantes
 *       concretos; el backend no los conoce. Las fechas van en ISO 8601 con
 *       zona explícita, porque dónde empieza y termina "el día" lo sabe el
 *       cliente.
 *
 *
 *       **`stock` NO sigue al período.** `rotacion` y `comprasPorProveedor` se
 *       recalculan sobre el período, pero `stock` es siempre el estado de
 *       AHORA, y lo dice en `stock.alcance`. El motivo es que la tabla `stock`
 *       es la caché del saldo actual y no guarda su propia historia: un stock
 *       histórico habría que reconstruirlo recorriendo el libro entero y no
 *       entraría en los 2 s de RNF2. Lo mismo arrastra `diasDeCobertura`, que
 *       cruza el stock de hoy con el ritmo de venta del período.
 *
 *
 *       Los días de la serie `porDia` y los del conteo de `periodo.dias` se
 *       cortan en la hora de Argentina (`periodo.zonaHoraria`), no en UTC.
 *
 *
 *       **Sin montos.** El modelo no guarda precios ni costos (la misma
 *       limitación que el historial de compras de HU-21), así que los
 *       indicadores son de volumen: unidades y cantidad de operaciones. Los
 *       campos `montos` vienen en `null` a propósito.
 *
 *
 *       **Tiempo real y RNF2 (menos de 2 s).** Cada bloque es una consulta
 *       agregada sobre índices, y el resultado se guarda en una caché por
 *       comercio Y período que se descarta sola en cuanto cambia el stock, un
 *       producto, un proveedor o una ubicación: una venta recién registrada
 *       aparece en la próxima carga. `generadoEn` dice cuándo se calcularon los
 *       números, así que dos respuestas con el mismo `generadoEn` son la misma
 *       foto.
 *       No hay websocket: el cliente refresca (al volver a la pestaña, o cada
 *       30–60 s).
 *     tags: [KPIs]
 *     parameters:
 *       - in: query
 *         name: dias
 *         schema: { type: integer, minimum: 1, default: 30, maximum: 90 }
 *         description: Días de la ventana móvil de rotación y compras, hoy incluido. Si se pide más del máximo, se recorta a 90. Excluyente con desde/hasta.
 *       - in: query
 *         name: desde
 *         schema:
 *           type: string
 *           format: date-time
 *           example: "2026-03-01T00:00:00.000-03:00"
 *         description: >
 *           Primer instante del período, INCLUSIVE. ISO 8601 con zona
 *           explícita (`Z` u offset); sin zona es 400. Va junto con `hasta` y
 *           es excluyente con `dias`.
 *       - in: query
 *         name: hasta
 *         schema:
 *           type: string
 *           format: date-time
 *           example: "2026-03-31T23:59:59.000-03:00"
 *         description: >
 *           Último instante del período, INCLUSIVE. El rango no puede abarcar
 *           más de 366 días calendario; si se pasa, es 400 y no se recorta.
 *     responses:
 *       200:
 *         description: Los KPIs del comercio
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 generadoEn: { type: string, format: date-time }
 *                 periodo:
 *                   type: object
 *                   properties:
 *                     dias:
 *                       type: integer
 *                       example: 30
 *                       description: "Días calendario que abarca el período. Con un rango, los días locales que tocan desde y hasta, los dos incluidos."
 *                     desde:
 *                       type: string
 *                       format: date-time
 *                       description: "Con `dias`, el inicio del primer día de la ventana. Con un rango, el `desde` que mandó el cliente, tal cual."
 *                     hasta:
 *                       type: string
 *                       format: date-time
 *                       description: "Con `dias`, el instante del pedido. Con un rango, el `hasta` que mandó el cliente, tal cual."
 *                     zonaHoraria: { type: string, example: America/Argentina/Buenos_Aires }
 *                 stock:
 *                   type: object
 *                   description: >
 *                     Estado actual de los productos activos. `sinStock`,
 *                     `bajoUmbral` y `normal` son excluyentes y suman
 *                     `productos`. Bajo umbral es "queda algo, pero en o por
 *                     debajo del umbral" (el criterio de HU-17); un umbral en 0
 *                     es "sin umbral" y nunca cuenta.
 *                   properties:
 *                     alcance:
 *                       type: string
 *                       enum: [actual]
 *                       example: actual
 *                       description: "Siempre `actual`: este bloque es el estado de ahora y el período no lo mueve. Rotularlo en pantalla."
 *                     productos: { type: integer, example: 42 }
 *                     unidades: { type: integer, example: 1830, description: "Unidades en stock sumando todas las ubicaciones" }
 *                     sinStock: { type: integer, example: 3 }
 *                     bajoUmbral: { type: integer, example: 5 }
 *                     normal: { type: integer, example: 34 }
 *                     productosSinVentas:
 *                       type: integer
 *                       example: 7
 *                       description: "Con stock y sin ninguna venta en la ventana. No cuenta los dados de alta dentro de la ventana."
 *                     porUbicacion:
 *                       type: array
 *                       description: Todas las ubicaciones del comercio, por nombre; las vacías vienen con 0.
 *                       items:
 *                         type: object
 *                         properties:
 *                           id: { type: string, format: uuid }
 *                           nombre: { type: string, example: Depósito }
 *                           unidades: { type: integer, example: 900 }
 *                           productos: { type: integer, example: 20, description: "Productos con existencias en esa ubicación" }
 *                 rotacion:
 *                   type: object
 *                   properties:
 *                     ventas: { type: integer, example: 120, description: "Movimientos de venta en la ventana" }
 *                     unidadesVendidas: { type: integer, example: 340 }
 *                     productosSinVentas: { type: integer, example: 7 }
 *                     masVendidos:
 *                       type: array
 *                       description: Hasta 5, por unidades vendidas. Incluye productos dados de baja (`producto.activo`).
 *                       items:
 *                         type: object
 *                         properties:
 *                           producto:
 *                             type: object
 *                             properties:
 *                               id: { type: string, format: uuid }
 *                               nombre: { type: string, example: Yerba 1 kg }
 *                               categoria: { type: string, example: Almacén }
 *                               unidadMedida: { type: string, example: unidad }
 *                               activo: { type: boolean }
 *                           ventas: { type: integer, example: 18 }
 *                           unidadesVendidas: { type: integer, example: 45 }
 *                           stockActual: { type: integer, example: 12 }
 *                           diasDeCobertura:
 *                             type: integer
 *                             nullable: true
 *                             example: 8
 *                             description: "Para cuántos días alcanza el stock al ritmo de venta de la ventana, redondeado para abajo"
 *                     porDia:
 *                       type: array
 *                       description: Un elemento por día de la ventana, del más viejo al de hoy, con 0 en los días sin ventas.
 *                       items:
 *                         type: object
 *                         properties:
 *                           fecha: { type: string, format: date, example: "2026-11-22" }
 *                           ventas: { type: integer, example: 4 }
 *                           unidades: { type: integer, example: 11 }
 *                     montos: { type: object, nullable: true, example: null }
 *                 comprasPorProveedor:
 *                   type: object
 *                   description: >
 *                     Solo movimientos de tipo `compra` de la ventana. Los
 *                     totales son de TODAS las compras, también las que no
 *                     entran en `proveedores` (van en `otros`) y las que no
 *                     tienen proveedor (`sinProveedor`).
 *                   properties:
 *                     compras: { type: integer, example: 14 }
 *                     unidades: { type: integer, example: 600 }
 *                     proveedoresConCompras: { type: integer, example: 4 }
 *                     proveedores:
 *                       type: array
 *                       description: Hasta 8, por unidades compradas. Incluye proveedores dados de baja (`proveedor.activo`).
 *                       items:
 *                         type: object
 *                         properties:
 *                           proveedor:
 *                             type: object
 *                             properties:
 *                               id: { type: string, format: uuid }
 *                               nombre: { type: string, example: Distribuidora Sur }
 *                               activo: { type: boolean }
 *                           compras: { type: integer, example: 6 }
 *                           unidades: { type: integer, example: 240 }
 *                           ultimaCompra: { type: string, format: date-time }
 *                     otros:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         proveedores: { type: integer }
 *                         compras: { type: integer }
 *                         unidades: { type: integer }
 *                     sinProveedor:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         compras: { type: integer }
 *                         unidades: { type: integer }
 *                     montos: { type: object, nullable: true, example: null }
 *       400:
 *         description: >
 *           `dias` no es un entero positivo; o se mandó `dias` junto con
 *           `desde`/`hasta`; o falta uno de los dos extremos del rango; o una
 *           fecha no es ISO 8601 con zona; o `desde` es posterior a `hasta`; o
 *           el rango abarca más de 366 días.
 *       401:
 *         description: No hay sesión activa
 *       403:
 *         description: El rol no puede ver los KPIs (el empleado no los ve)
 */
router.get("/", requirePermission({ kpi: ["read"] }), controller.obtener);

export default router;
