import { Router } from "express";
import * as controller from "../controllers/reportes.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth.middleware.js";

const router = Router();

// Todo lo de acá exige sesión. `requireAuth` deja el `comercioId` en `req`, y
// es lo que hace que cada reporte salga solo con datos del propio comercio.
router.use(requireAuth);

/**
 * @openapi
 * /api/reportes/movimientos:
 *   get:
 *     summary: Reporte de movimientos en PDF por período, producto o proveedor (HU-25)
 *     description: >
 *       Genera y descarga un PDF con los movimientos de stock del comercio en
 *       el rango pedido, del más viejo al más nuevo. El encabezado trae el
 *       nombre del comercio, la fecha y hora de generación, el tipo de reporte,
 *       el rango y los filtros aplicados; al final, los totales (movimientos,
 *       unidades que entraron y salieron, saldo neto y desglose por tipo). Cada
 *       hoja lleva "Página X de Y".
 *
 *
 *       Los tres tipos exigen `desde` y `hasta`. El reporte por `producto`
 *       exige `productoId` y el reporte por `proveedor` exige `proveedorId`;
 *       mandar uno de esos en un tipo que no lo usa es un 400. Los productos y
 *       proveedores dados de baja se pueden reportar igual: siguen teniendo
 *       historia.
 *
 *
 *       **Sin movimientos en el rango responde 200** con un PDF que lo indica:
 *       es un resultado válido para archivar, no un error.
 *
 *
 *       El PDF **no incluye montos**: el modelo todavía no registra precios ni
 *       costos. Lo aclara en una nota al pie.
 *
 *
 *       Solo propietario y gerente (`reporte: generar`). El empleado consulta
 *       el historial (HU-14) pero no exporta reportes.
 *
 *
 *       Para leer el nombre del archivo desde el Frontend, el header
 *       `Content-Disposition` está expuesto por CORS.
 *     tags: [Reportes]
 *     parameters:
 *       - in: query
 *         name: tipo
 *         required: true
 *         schema:
 *           type: string
 *           enum: [periodo, producto, proveedor]
 *       - in: query
 *         name: desde
 *         required: true
 *         schema: { type: string, format: date-time, example: "2026-09-01T03:00:00.000Z" }
 *         description: Fecha y hora mínima, inclusiva. ISO 8601 con zona.
 *       - in: query
 *         name: hasta
 *         required: true
 *         schema: { type: string, format: date-time, example: "2026-10-01T02:59:59.999Z" }
 *         description: Fecha y hora máxima, inclusiva. ISO 8601 con zona.
 *       - in: query
 *         name: productoId
 *         schema: { type: string, format: uuid }
 *         description: Obligatorio con `tipo=producto`; no se acepta con otro tipo.
 *       - in: query
 *         name: proveedorId
 *         schema: { type: string, format: uuid }
 *         description: Obligatorio con `tipo=proveedor`; no se acepta con otro tipo.
 *       - in: query
 *         name: zonaHoraria
 *         schema: { type: string, default: America/Argentina/Buenos_Aires }
 *         description: >
 *           Zona IANA con la que se muestran las fechas dentro del PDF y en el
 *           nombre del archivo. No cambia qué movimientos entran: eso lo
 *           deciden `desde` y `hasta`.
 *     responses:
 *       200:
 *         description: >
 *           El PDF. Se descarga como
 *           `reporte-movimientos-{tipo}[-{producto o proveedor}]-{aaaa-mm-dd}_{aaaa-mm-dd}.pdf`.
 *         headers:
 *           Content-Disposition:
 *             schema: { type: string, example: 'attachment; filename="reporte-movimientos-periodo-2026-09-01_2026-09-30.pdf"' }
 *           Cache-Control:
 *             schema: { type: string, example: no-store }
 *         content:
 *           application/pdf:
 *             schema: { type: string, format: binary }
 *       400:
 *         description: >
 *           Falta `tipo` o no es válido; falta `desde` o `hasta`, no tienen
 *           formato ISO con zona, o `desde` es posterior a `hasta`; falta
 *           `productoId`/`proveedorId` para su tipo, o vino en un tipo que no
 *           lo usa; la zona horaria no existe; o el rango tiene más de 5000
 *           movimientos.
 *       401:
 *         description: No hay sesión activa
 *       403:
 *         description: El rol no puede generar reportes (empleado)
 *       404:
 *         description: El producto o el proveedor no existen en este comercio
 */
router.get(
  "/movimientos",
  requirePermission({ reporte: ["generar"] }),
  controller.generarMovimientos,
);

export default router;
