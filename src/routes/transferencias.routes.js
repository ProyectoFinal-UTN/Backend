import { Router } from "express";
import * as controller from "../controllers/transferencias.controller.js";
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
 * /api/transferencias:
 *   post:
 *     summary: Transfiere stock de una ubicación a otra (HU-12)
 *     description: >
 *       Descuenta del origen y suma al destino en una sola transacción: o pasan
 *       las dos cosas, o no pasa ninguna. La transferencia queda registrada en
 *       el libro como **dos movimientos de tipo `transferencia` ligados por
 *       `transferenciaId`**: cantidad negativa en la ubicación de origen y
 *       positiva en la de destino.
 *
 *
 *       La `cantidad` se envía siempre como magnitud positiva; el signo de cada
 *       pata lo pone el servidor. No se permite transferir más unidades de las
 *       disponibles en el origen. Si el producto todavía no tenía stock en el
 *       destino, la fila se crea con la cantidad transferida.
 *
 *
 *       El proveedor no aplica: una transferencia es un movimiento interno
 *       entre dos ubicaciones del mismo comercio, así que los dos movimientos
 *       quedan con `proveedorId` en `null`.
 *     tags: [Movimientos]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productoId, ubicacionOrigenId, ubicacionDestinoId, cantidad]
 *             properties:
 *               productoId: { type: string, format: uuid }
 *               ubicacionOrigenId: { type: string, format: uuid }
 *               ubicacionDestinoId:
 *                 type: string
 *                 format: uuid
 *                 description: Tiene que ser distinta de la de origen.
 *               cantidad:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 2147483647
 *                 example: 10
 *                 description: >
 *                   Magnitud positiva, siempre. Tiene que ser un número JSON,
 *                   no una cadena.
 *               motivo:
 *                 type: string
 *                 maxLength: 255
 *                 example: Reposición de góndola
 *                 description: >
 *                   Opcional, a diferencia de los ajustes y las mermas (HU-15):
 *                   el par de movimientos ligados ya explica qué pasó. Si se
 *                   manda, se guarda en la transferencia y en los dos
 *                   movimientos.
 *     responses:
 *       201:
 *         description: >
 *           Transferencia realizada. Devuelve el encabezado de la
 *           transferencia, los dos movimientos que generó y el stock resultante
 *           en el origen y en el destino.
 *       400:
 *         description: >
 *           Datos inválidos, falta una de las ubicaciones, origen y destino son
 *           la misma, cantidad no entera o fuera de rango, o `motivo` de más de
 *           255 caracteres
 *       401:
 *         description: No hay sesión activa
 *       403:
 *         description: >
 *           El rol no tiene el permiso `transferencia: ["create"]` (hoy lo
 *           tienen los tres roles)
 *       404:
 *         description: >
 *           El producto o alguna de las ubicaciones no existen en este comercio
 *       409:
 *         description: >
 *           La transferencia no entra contra el stock actual: o el origen no
 *           tiene unidades suficientes, o el saldo del destino superaría el
 *           máximo de 2147483647.
 */
router.post(
  "/",
  // Permiso propio desde HU-32, aunque hoy lo tengan los mismos tres roles que
  // `movimiento: ["create"]`. Vaciar un depósito hacia otro local no es lo
  // mismo que registrar una venta, y el día que se quiera restringir alcanza
  // con cambiar la matriz de src/lib/permissions.js sin tocar movimientos.
  requirePermission({ transferencia: ["create"] }),
  controller.transferir,
);

export default router;
