import { Router } from "express";
import * as controller from "../controllers/push.controller.js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth.middleware.js";

const router = Router();

// Todo lo de acá exige sesión: la suscripción queda a nombre del usuario y del
// comercio de la sesión, nunca de lo que diga el body. Y las tres rutas piden
// `alerta: read` (HU-32: toda ruta de negocio valida permiso): el push es otra
// forma de ver las alertas de reposición.
router.use(requireAuth);

const puedeVerAlertas = requirePermission({ alerta: ["read"] });

/**
 * @openapi
 * components:
 *   schemas:
 *     SuscripcionPush:
 *       type: object
 *       description: >
 *         Lo que devuelve `PushSubscription.toJSON()` en el navegador, tal cual.
 *       required: [endpoint, keys]
 *       properties:
 *         endpoint:
 *           type: string
 *           format: uri
 *           example: https://fcm.googleapis.com/fcm/send/dXb3...
 *         expirationTime:
 *           type: number
 *           nullable: true
 *           description: Milisegundos desde 1970. Casi siempre `null`.
 *         keys:
 *           type: object
 *           required: [p256dh, auth]
 *           properties:
 *             p256dh: { type: string, example: BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM }
 *             auth: { type: string, example: tBHItJI5svbpez7KI4CCXg }
 *     AvisoDeReposicion:
 *       type: object
 *       description: >
 *         Contenido (JSON) de cada push de reposición. No es la respuesta de
 *         ningún endpoint: es lo que recibe el service worker del Frontend en
 *         el evento `push`.
 *       properties:
 *         tipo: { type: string, enum: [alerta_reposicion] }
 *         titulo: { type: string, example: "Reponer: Yerba 1 kg" }
 *         cuerpo: { type: string, example: "Stock actual: 3 (mínimo 10)" }
 *         productoId: { type: string, format: uuid }
 *         stockActual: { type: integer, example: 3 }
 *         umbralMinimo: { type: integer, example: 10 }
 * /api/push/clave-publica:
 *   get:
 *     summary: Clave pública VAPID para suscribirse a las notificaciones push (HU-18)
 *     description: >
 *       El Frontend la pasa como `applicationServerKey` a
 *       `pushManager.subscribe()`. Si el servidor no tiene configuradas las
 *       claves VAPID, el push está desactivado y responde 503: el Frontend
 *       debería ocultar la opción de activar notificaciones.
 *     tags: [Notificaciones push]
 *     responses:
 *       200:
 *         description: La clave pública, en base64url
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 clavePublica: { type: string }
 *       401:
 *         description: No hay sesión activa
 *       403:
 *         description: El rol no puede ver alertas de reposición
 *       503:
 *         description: Las notificaciones push no están configuradas en este servidor
 */
router.get("/clave-publica", puedeVerAlertas, controller.obtenerClavePublica);

/**
 * @openapi
 * /api/push/suscripciones:
 *   post:
 *     summary: Activa las notificaciones push en este dispositivo (HU-18)
 *     description: >
 *       Guarda la suscripción del navegador para el usuario y el comercio de la
 *       sesión. Desde ese momento, cada vez que un movimiento hace que un
 *       producto llegue a su umbral mínimo (o baje de él), el dispositivo
 *       recibe un push con el contenido de `AvisoDeReposicion`.
 *
 *
 *       Si el endpoint ya estaba suscripto, no se duplica: se actualizan sus
 *       claves y se reasigna al usuario y comercio actuales (por ejemplo, si
 *       en ese celular se logueó otra persona).
 *
 *
 *       Lo pueden usar los roles con `alerta: read` (hoy, los tres).
 *     tags: [Notificaciones push]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: "#/components/schemas/SuscripcionPush" }
 *     responses:
 *       201:
 *         description: Suscripción guardada
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 endpoint: { type: string }
 *                 expiraEn: { type: string, format: date-time, nullable: true }
 *       400:
 *         description: >
 *           El body no es una suscripción válida: falta el endpoint o no es
 *           una URL https, o faltan las claves `p256dh` y `auth`.
 *       401:
 *         description: No hay sesión activa
 *       403:
 *         description: El rol no puede ver alertas de reposición
 *   delete:
 *     summary: Silencia las notificaciones push en este dispositivo (HU-18)
 *     description: >
 *       Borra la suscripción del navegador. Es como se silencian las
 *       notificaciones, y lo que tiene que llamar el Frontend al cerrar sesión.
 *
 *
 *       Solo borra suscripciones del usuario de la sesión. Si el endpoint no
 *       existe o es de otro usuario, responde 204 igual y no cambia nada.
 *     tags: [Notificaciones push]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [endpoint]
 *             properties:
 *               endpoint: { type: string, format: uri }
 *     responses:
 *       204:
 *         description: Suscripción borrada (o no había ninguna)
 *       400:
 *         description: Falta el endpoint o no es una URL https
 *       401:
 *         description: No hay sesión activa
 *       403:
 *         description: El rol no puede ver alertas de reposición
 */
router.post("/suscripciones", puedeVerAlertas, controller.suscribir);

router.delete("/suscripciones", puedeVerAlertas, controller.desuscribir);

export default router;
