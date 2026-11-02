import { Router } from "express";
import * as controller from "../controllers/alertas.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth.middleware.js";

const router = Router();

// Todo lo de acá exige sesión. `requireAuth` deja el `comercioId` en `req`,
// que es lo que hace que cada comercio vea solo sus alertas.
router.use(requireAuth);

/**
 * @openapi
 * components:
 *   schemas:
 *     AlertaReposicion:
 *       type: object
 *       properties:
 *         id: { type: string, format: uuid }
 *         generadaEn: { type: string, format: date-time, example: "2026-10-29T13:05:00.000Z" }
 *         producto:
 *           type: object
 *           properties:
 *             id: { type: string, format: uuid }
 *             nombre: { type: string, example: Yerba 1 kg }
 *             codigoBarras: { type: string, example: "7790000000000" }
 *             categoria: { type: string, example: Almacén }
 *             unidadMedida: { type: string, example: unidad }
 *         stockActual:
 *           type: integer
 *           example: 3
 *           description: "Saldo vivo del producto en todo el comercio, sumando todas las ubicaciones"
 *         umbralMinimo:
 *           type: integer
 *           example: 10
 *           description: "Umbral vigente del producto (HU-16), no el que tenía al generarse la alerta"
 *         faltanteHastaElUmbral:
 *           type: integer
 *           example: 7
 *           description: "Cuánto hay que reponer para volver al umbral. Un producto justo en el mínimo da 0"
 *         stockAlGenerar:
 *           type: integer
 *           example: 3
 *           description: "Foto del saldo en el momento en que nació la alerta, para ver si siguió bajando"
 *         umbralAlGenerar:
 *           type: integer
 *           example: 10
 *           description: "Foto del umbral en el momento en que nació la alerta"
 *         ubicaciones:
 *           type: array
 *           description: >
 *             Dónde está repartido lo que queda. El umbral es por producto y se
 *             compara contra el total del comercio, así que una alerta no tiene
 *             una sola ubicación. Las ubicaciones sin existencias no aparecen.
 *           items:
 *             type: object
 *             properties:
 *               id: { type: string, format: uuid }
 *               nombre: { type: string, example: Depósito }
 *               cantidad: { type: integer, example: 2 }
 *         proveedorSugerido:
 *           type: object
 *           nullable: true
 *           description: >
 *             A quién pedirle. Es el primero por nombre de `proveedores`, o
 *             `null` si el producto no tiene ningún proveedor activo asociado
 *             (HU-20): la alerta aparece igual, porque el faltante existe
 *             aunque no se sepa a quién comprarle.
 *           properties:
 *             id: { type: string, format: uuid }
 *             nombre: { type: string, example: Distribuidora Sur }
 *             telefono: { type: string, nullable: true, example: "11 5555-0000" }
 *             correo: { type: string, nullable: true, example: ventas@distrisur.com }
 *         proveedores:
 *           type: array
 *           description: >
 *             Todos los proveedores activos asociados al producto, ordenados
 *             por nombre. La relación es N:M, así que puede haber más de uno y
 *             el modelo no guarda cuál es el principal.
 *           items: { $ref: "#/components/schemas/Proveedor" }
 */

/**
 * @openapi
 * /api/alertas:
 *   get:
 *     summary: Alertas de reposición activas del comercio (HU-17)
 *     description: >
 *       Los productos que alcanzaron su umbral mínimo y todavía no se
 *       repusieron, de la más urgente a la menos urgente. Es lo que muestra el
 *       panel principal.
 *
 *
 *       **Las alertas no se calculan acá.** Cada una es una fila que nació
 *       dentro de la misma transacción que movió el stock, y que se marca como
 *       resuelta —también dentro de una transacción— en cuanto una reposición
 *       deja el saldo por encima del umbral. Este endpoint solo lee las
 *       activas.
 *
 *
 *       Un producto entra en falta cuando su saldo queda **igual o por debajo**
 *       del umbral: el criterio de aceptación dice "alcanzaron su umbral
 *       mínimo", y alcanzar es llegar, no pasar. Un `umbralMinimo` en 0
 *       significa "sin umbral configurado" (HU-16) y nunca genera alerta.
 *
 *
 *       El saldo que se compara es el **total del comercio**, sumando todas las
 *       ubicaciones: tener el umbral cubierto entre el depósito y el salón
 *       significa que no hay que comprar. El reparto va en `ubicaciones`.
 *
 *
 *       **En tiempo real es por refresco del cliente**, no hay websocket: se
 *       sugiere volver a pedir este listado cada 30–60 segundos o al recuperar
 *       el foco de la pestaña. Para el aviso inmediato están las notificaciones
 *       push de HU-18, que salen en el momento en que nace la alerta.
 *     tags: [Alertas]
 *     parameters:
 *       - in: query
 *         name: pagina
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limite
 *         schema: { type: integer, minimum: 1, default: 50, maximum: 200 }
 *         description: Si se pide más del máximo, se recorta a 200.
 *     responses:
 *       200:
 *         description: Página de alertas activas y la paginación
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 alertas:
 *                   type: array
 *                   description: >
 *                     Ordenadas por urgencia: primero las que están más lejos
 *                     de su umbral. Desempatan por nombre de producto y por id,
 *                     para que la paginación no repita ni saltee filas.
 *                   items: { $ref: "#/components/schemas/AlertaReposicion" }
 *                 paginacion:
 *                   type: object
 *                   properties:
 *                     pagina: { type: integer, example: 1 }
 *                     limite: { type: integer, example: 50 }
 *                     total: { type: integer, example: 4, description: "Alertas activas en total, no las de esta página" }
 *                     totalPaginas: { type: integer, example: 1 }
 *       400:
 *         description: "`pagina` o `limite` no son enteros positivos"
 *       401:
 *         description: No hay sesión activa
 *       403:
 *         description: El rol no puede ver las alertas de reposición
 */
router.get("/", requirePermission({ alerta: ["read"] }), controller.listarActivas);

export default router;
