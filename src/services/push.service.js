import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { comercio, member, suscripcionPush } from "../db/schema.js";
import { ErrorDeNegocio } from "../lib/errores.js";
import { puede } from "../lib/permissions.js";
import { clavePublica, enviarPush, pushHabilitado } from "../lib/push.js";

/**
 * Notificaciones push de reposicion (HU-18).
 *
 * Dos mitades:
 *
 * - Las suscripciones: cada navegador que acepta notificaciones manda su
 *   `PushSubscription` y se guarda en `suscripcion_push`. Silenciar es borrarla
 *   (criterio 2 de la historia): no hay otra preferencia que mantener.
 * - El aviso: cuando un movimiento hace nacer una alerta de reposicion
 *   (HU-17), se le manda un push a cada suscripcion del comercio (criterio 1).
 *
 * Desde HU-17 este modulo ya no detecta el cruce de umbral: lo hace
 * `evaluarAlertaDeStock` dentro de la transaccion del movimiento, y aca solo
 * llega el resultado. El anti-duplicado —no repetir el aviso de un producto
 * que ya estaba en falta— pasa a ser el indice unico parcial de la tabla
 * `alerta`, que es lo que arregla el duplicado bajo concurrencia que esta
 * misma funcion tenia documentado.
 *
 * El aviso nunca puede romper ni demorar el registro del movimiento: corre
 * despues del commit, sin que la respuesta lo espere, y todo error queda en la
 * consola. Ver `programarAvisoDeReposicion`.
 *
 * Igual que el resto de los services, `comercioId` y `usuarioId` salen siempre
 * de la sesion, nunca del body.
 */

/** Permiso que hace falta para recibir avisos de reposicion. */
const PERMISO_ALERTAS = { alerta: ["read"] };

/**
 * Respuestas del servicio de push que significan "esta suscripcion ya no
 * existe": el usuario revoco el permiso, desinstalo la app o el navegador la
 * renovo. Reintentar no sirve, asi que la fila se borra.
 */
const SUSCRIPCION_VENCIDA = [404, 410];

/** Topes de largo: lo que pase de aca no es una suscripcion real. */
const ENDPOINT_MAXIMO = 2048;
const CLAVE_MAXIMA = 256;
const USER_AGENT_MAXIMO = 255;

/** Las claves de una PushSubscription vienen en base64url. */
const FORMATO_BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/* ---------------------------------------------------------------------------
 * Suscripciones
 * ------------------------------------------------------------------------- */

function leerEndpoint(valor) {
  if (typeof valor !== "string" || valor.trim() === "") {
    throw new ErrorDeNegocio("Falta el endpoint de la suscripción", 400);
  }

  const endpoint = valor.trim();
  let url;

  try {
    url = new URL(endpoint);
  } catch {
    url = null;
  }

  // Solo https: los servicios de push de los navegadores no exponen otra cosa,
  // y aceptar cualquier URL convertiria el envio en una forma de hacer que el
  // backend le pegue a direcciones arbitrarias.
  if (!url || url.protocol !== "https:" || endpoint.length > ENDPOINT_MAXIMO) {
    throw new ErrorDeNegocio(
      "El endpoint de la suscripción no es una URL https válida",
      400,
    );
  }

  return endpoint;
}

function leerClave(valor, nombre) {
  if (
    typeof valor !== "string" ||
    valor === "" ||
    valor.length > CLAVE_MAXIMA ||
    !FORMATO_BASE64URL.test(valor)
  ) {
    throw new ErrorDeNegocio(
      `Falta la clave "${nombre}" de la suscripción o no es válida`,
      400,
    );
  }

  return valor;
}

/**
 * Valida el body de `POST /api/push/suscripciones`, que es tal cual lo que
 * devuelve `PushSubscription.toJSON()` en el navegador.
 *
 * Pura, sin base, para testearla sola. Devuelve solo los campos conocidos: un
 * `usuarioId` o `comercioId` que venga en el body se pierde aca.
 */
export function validarSuscripcion(datosCrudos = {}) {
  const datos = datosCrudos ?? {};
  const claves = datos.keys ?? {};

  if (typeof claves !== "object") {
    throw new ErrorDeNegocio("Faltan las claves de la suscripción", 400);
  }

  const expiracion = datos.expirationTime;
  let expiraEn = null;

  if (expiracion !== undefined && expiracion !== null) {
    // `expirationTime` es un timestamp en milisegundos (DOMHighResTimeStamp).
    if (typeof expiracion !== "number" || !Number.isFinite(expiracion) || expiracion < 0) {
      throw new ErrorDeNegocio(
        "El expirationTime de la suscripción debe ser un número o null",
        400,
      );
    }
    expiraEn = new Date(expiracion);
  }

  return {
    endpoint: leerEndpoint(datos.endpoint),
    p256dh: leerClave(claves.p256dh, "p256dh"),
    auth: leerClave(claves.auth, "auth"),
    expiraEn,
  };
}

/** Valida el body de `DELETE /api/push/suscripciones`. */
export function validarBaja(datosCrudos = {}) {
  return { endpoint: leerEndpoint((datosCrudos ?? {}).endpoint) };
}

/** La clave publica VAPID para que el Frontend se suscriba. */
export function obtenerClavePublica() {
  const clave = clavePublica();

  if (!clave) {
    throw new ErrorDeNegocio(
      "Las notificaciones push no están disponibles en este servidor",
      503,
    );
  }

  return { clavePublica: clave };
}

/**
 * Guarda la suscripcion de un dispositivo para el usuario y comercio de la
 * sesion.
 *
 * Upsert por `endpoint`: si el navegador ya estaba suscripto —el mismo usuario
 * reactivando, u otro que se logueo en ese celular— la fila se reasigna a quien
 * esta ahora, en vez de duplicarse. Dos filas con el mismo endpoint harian que
 * el dispositivo reciba avisos de dos comercios.
 */
export async function guardarSuscripcion(
  comercioId,
  usuarioId,
  datosCrudos,
  userAgent,
) {
  const datos = validarSuscripcion(datosCrudos);
  const agente =
    typeof userAgent === "string" && userAgent !== ""
      ? userAgent.slice(0, USER_AGENT_MAXIMO)
      : null;

  const valores = {
    comercioId,
    usuarioId,
    p256dh: datos.p256dh,
    auth: datos.auth,
    userAgent: agente,
    expiraEn: datos.expiraEn,
  };

  const [guardada] = await db
    .insert(suscripcionPush)
    .values({ ...valores, endpoint: datos.endpoint })
    .onConflictDoUpdate({
      target: suscripcionPush.endpoint,
      set: { ...valores, updatedAt: new Date() },
    })
    .returning({
      endpoint: suscripcionPush.endpoint,
      expiraEn: suscripcionPush.expiraEn,
    });

  return guardada;
}

/**
 * Borra la suscripcion de un dispositivo: es como el Frontend silencia las
 * notificaciones, y lo que llama al cerrar sesion.
 *
 * Solo borra si es del usuario de la sesion. Si no existe o es de otro, no
 * hace nada y no avisa: la respuesta es la misma (204), asi que no sirve para
 * averiguar si un endpoint ajeno esta suscripto.
 */
export async function eliminarSuscripcion(usuarioId, datosCrudos) {
  const { endpoint } = validarBaja(datosCrudos);

  await db
    .delete(suscripcionPush)
    .where(
      and(
        eq(suscripcionPush.endpoint, endpoint),
        eq(suscripcionPush.usuarioId, usuarioId),
      ),
    );
}

/* ---------------------------------------------------------------------------
 * Aviso de reposicion
 * ------------------------------------------------------------------------- */

/**
 * Contenido del push. Es el contrato con el service worker del Frontend, que
 * lo lee para mostrar la notificacion y abrir el producto al tocarla.
 */
export function armarAvisoDeReposicion({
  productoId,
  nombre,
  stockActual,
  umbralMinimo,
}) {
  return {
    tipo: "alerta_reposicion",
    titulo: `Reponer: ${nombre}`,
    cuerpo: `Stock actual: ${stockActual} (mínimo ${umbralMinimo})`,
    productoId,
    stockActual,
    umbralMinimo,
  };
}

/**
 * Las suscripciones del comercio cuyos usuarios pueden ver las alertas.
 *
 * El join con MEMBER deja afuera a quien ya no es parte del comercio (lo
 * sacaron del equipo pero su celular sigue suscripto), y el rol se chequea
 * contra la matriz de permisos: si mañana un rol deja de ver alertas, tampoco
 * recibe el push, sin tocar este archivo.
 */
async function suscripcionesConPermiso(comercioId) {
  const filas = await db
    .select({
      id: suscripcionPush.id,
      endpoint: suscripcionPush.endpoint,
      p256dh: suscripcionPush.p256dh,
      auth: suscripcionPush.auth,
      rol: member.role,
    })
    .from(suscripcionPush)
    .innerJoin(comercio, eq(comercio.id, suscripcionPush.comercioId))
    .innerJoin(
      member,
      and(
        eq(member.organizationId, comercio.organizationId),
        eq(member.userId, suscripcionPush.usuarioId),
      ),
    )
    .where(eq(suscripcionPush.comercioId, comercioId));

  return filas.filter((fila) => puede(fila.rol, PERMISO_ALERTAS));
}

/** Manda el aviso a una suscripcion y resuelve que hacer si falla. */
async function enviarA(comercioId, suscripcion, aviso) {
  try {
    await enviarPush(suscripcion, aviso);
    return "enviado";
  } catch (error) {
    if (SUSCRIPCION_VENCIDA.includes(error?.statusCode)) {
      await db
        .delete(suscripcionPush)
        .where(
          and(
            eq(suscripcionPush.id, suscripcion.id),
            eq(suscripcionPush.comercioId, comercioId),
          ),
        );
      return "borrada";
    }

    // Una falla pasajera (el servicio de push caido, un timeout) no borra
    // nada: la suscripcion sigue siendo valida para el proximo aviso.
    console.error(
      `[push] no se pudo enviar el aviso a la suscripcion ${suscripcion.id}:`,
      error?.statusCode ?? "",
      error?.message ?? error,
    );
    return "fallido";
  }
}

/**
 * Manda el push de reposicion si el movimiento abrio una alerta nueva.
 *
 * Se llama con la alerta que devolvio la transaccion del movimiento (HU-17),
 * ya commiteada. `alerta.nueva` es el evento "este producto acaba de entrar en
 * falta": lo contesta el indice unico parcial de la tabla, no una comparacion,
 * asi que dos ventas simultaneas del mismo producto no pueden hacer nacer dos
 * alertas y el aviso no puede salir dos veces. Era justo el limite que esta
 * funcion tenia documentado antes de HU-17.
 *
 * Tampoco hace falta chequear el signo del movimiento ni releer el stock: una
 * entrada que no deja el producto en falta no genera alerta, y la alerta ya
 * trae el nombre, el stock y el umbral con los que nacio.
 *
 * @returns {Promise<{enviado: number, borrada: number, fallido: number}>}
 */
export async function avisarSiCruzoElUmbral(comercioId, alerta) {
  const resultado = { enviado: 0, borrada: 0, fallido: 0 };

  if (!pushHabilitado() || !alerta?.nueva) {
    return resultado;
  }

  const aviso = armarAvisoDeReposicion(alerta);

  const suscripciones = await suscripcionesConPermiso(comercioId);

  // En paralelo: una suscripcion lenta no tiene por que demorar a las demas.
  const estados = await Promise.all(
    suscripciones.map((suscripcion) => enviarA(comercioId, suscripcion, aviso)),
  );

  for (const estado of estados) {
    resultado[estado] += 1;
  }

  return resultado;
}

/** Avisos que todavia estan corriendo. Ver `esperarAvisosPendientes`. */
const avisosPendientes = new Set();

/**
 * Dispara el aviso de reposicion sin esperarlo (criterio 1 de HU-18).
 *
 * Es lo unico que llama `registrarMovimiento`, despues del commit, con la
 * alerta que dejo la transaccion. No devuelve nada y no puede tirar: el
 * movimiento ya esta guardado y la respuesta al usuario no tiene por que
 * depender de que el servicio de push conteste.
 */
export function programarAvisoDeReposicion(comercioId, alerta) {
  const aviso = Promise.resolve()
    .then(() => avisarSiCruzoElUmbral(comercioId, alerta))
    .catch((error) => {
      console.error("[push] fallo el aviso de reposicion:", error);
    })
    .finally(() => avisosPendientes.delete(aviso));

  avisosPendientes.add(aviso);
}

/**
 * Espera a que terminen los avisos en curso. Sirve para los tests, que tienen
 * que saber cuando el envio en segundo plano ya paso, y para un cierre
 * ordenado del servidor si algun dia hace falta.
 */
export async function esperarAvisosPendientes() {
  await Promise.all([...avisosPendientes]);
}
