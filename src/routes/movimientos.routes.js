import { Router } from "express";
import * as controller from "../controllers/movimientos.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth.middleware.js";

const router = Router();

// Todo lo de acá exige sesión. `requireAuth` deja el `comercioId` y el usuario
// en `req`, que es lo que hace que cada comercio mueva solo su propio stock.
router.use(requireAuth);

/**
 * @openapi
 * /api/movimientos:
 *   post:
 *     summary: Registra un movimiento de entrada o salida de stock (HU-13, HU-15)
 *     description: >
 *       Inserta el movimiento en el libro y actualiza el stock del producto en
 *       la misma transacción, de forma atómica. La `cantidad` se envía siempre
 *       como magnitud positiva: el signo lo determina el tipo (compra suma;
 *       venta y merma restan) y, en un ajuste, el campo `sentido`.
 *
 *
 *       Si el comercio tiene una sola ubicación, `ubicacionId` puede omitirse.
 *       No se permite descontar más unidades de las disponibles.
 *
 *
 *       Los ajustes y las mermas (HU-15) exigen `motivo`: son correcciones
 *       entre el stock del sistema y el real, y sin la explicación el libro
 *       registra la diferencia pero no por qué se produjo. Quedan
 *       diferenciados de compras y ventas por el campo `tipo`.
 *     tags: [Movimientos]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productoId, tipo, cantidad]
 *             properties:
 *               productoId: { type: string, format: uuid }
 *               tipo:
 *                 type: string
 *                 enum: [compra, venta, ajuste, merma]
 *                 description: >
 *                   `transferencia` no se acepta acá: esos movimientos los crea
 *                   el flujo de transferencia entre ubicaciones (HU-12), en
 *                   pares ligados.
 *               cantidad:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 2147483647
 *                 example: 3
 *                 description: >
 *                   Magnitud positiva, siempre. Tiene que ser un número JSON,
 *                   no una cadena.
 *               sentido:
 *                 type: string
 *                 enum: [entrada, salida]
 *                 description: Obligatorio solo cuando el tipo es `ajuste`.
 *               motivo:
 *                 type: string
 *                 maxLength: 255
 *                 example: Rotura de mercadería en el depósito
 *                 description: >
 *                   Por qué se hace el movimiento. **Obligatorio** cuando el
 *                   tipo es `ajuste` o `merma`, y no puede venir vacío ni en
 *                   blanco. En una compra o una venta es opcional: si no se
 *                   manda, se guarda `null`.
 *               ubicacionId:
 *                 type: string
 *                 format: uuid
 *                 description: >
 *                   Opcional si el comercio tiene una única ubicación.
 *               proveedorId:
 *                 type: string
 *                 format: uuid
 *                 description: >
 *                   Proveedor asociado, cuando corresponde (típicamente en una
 *                   compra). Todavía sin validación contra PROVEEDOR (HU-19).
 *     responses:
 *       201:
 *         description: >
 *           Movimiento registrado. Devuelve el movimiento (con la cantidad ya
 *           con signo) y el stock resultante de esa ubicación.
 *       400:
 *         description: >
 *           Datos inválidos, ajuste sin sentido, ajuste o merma sin `motivo`,
 *           `motivo` de más de 255 caracteres, o falta `ubicacionId` en un
 *           comercio con más de una ubicación
 *       401:
 *         description: No hay sesión activa
 *       403:
 *         description: El rol no puede registrar movimientos
 *       404:
 *         description: El producto o la ubicación no existen en este comercio
 *       409:
 *         description: >
 *           El movimiento no entra contra el stock actual: o no hay unidades
 *           suficientes para descontar, o el saldo resultante superaría el
 *           máximo de 2147483647.
 */
router.post(
  "/",
  requirePermission({ movimiento: ["create"] }),
  controller.registrar,
);

export default router;
