import webpush from "web-push";

/**
 * Envio de notificaciones push (HU-18), con Web Push estandar y claves VAPID.
 *
 * Un solo lugar habla con el servicio de push, igual que `correo.js` con
 * Resend: el resto del codigo llama a `enviarPush` sin saber que libreria hay
 * abajo. Es tambien lo que mockean los tests, asi ninguno manda un push real.
 *
 * Web Push y no Firebase Cloud Messaging: es el estandar de los navegadores,
 * no necesita cuenta ni SDK de Google, y el proyecto no usaba Firebase para
 * nada. VAPID es el par de claves con el que el backend se identifica ante el
 * servicio de push del navegador; la publica la usa el Frontend al suscribirse.
 *
 * ## Sin claves, el backend arranca igual
 *
 * Mismo criterio que `LLM_API_KEY` y `RESEND_API_KEY`: si faltan las variables
 * (o son invalidas), se avisa una vez por consola, no se manda ningun push y
 * `GET /api/push/clave-publica` responde 503. Asi nadie del equipo necesita las
 * claves para levantar el proyecto.
 */

const clavePublicaVapid = process.env.VAPID_PUBLIC_KEY?.trim() || "";
const clavePrivadaVapid = process.env.VAPID_PRIVATE_KEY?.trim() || "";
// Contacto que el servicio de push puede usar si hay un problema con los
// envios: `mailto:` o una URL https. Apple rechaza los envios sin uno valido.
const contactoVapid = process.env.VAPID_SUBJECT?.trim() || "";

/**
 * Cuanto guarda el servicio de push el mensaje si el dispositivo esta apagado,
 * en segundos. Un dia: pasado eso, el aviso de "reponer" ya llega tarde y el
 * panel de alertas lo dice igual.
 */
const TTL_SEGUNDOS = 24 * 60 * 60;

function configurar() {
  if (!clavePublicaVapid || !clavePrivadaVapid || !contactoVapid) {
    return "faltan VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY o VAPID_SUBJECT";
  }

  try {
    // Valida el formato de las claves y del contacto: con algo mal tira aca y
    // no recien en el primer envio.
    webpush.setVapidDetails(contactoVapid, clavePublicaVapid, clavePrivadaVapid);
    return null;
  } catch (error) {
    return `las variables VAPID no son validas (${error.message})`;
  }
}

const motivoDeshabilitado = configurar();

// En los tests no se avisa: todo archivo que importa la app pasaria por aca, y
// el aviso ensuciaria la salida de la suite sin decir nada nuevo.
if (motivoDeshabilitado && process.env.NODE_ENV !== "test") {
  console.warn(
    `[push] Notificaciones push desactivadas: ${motivoDeshabilitado}. El resto del backend funciona igual.`,
  );
}

/** Si hay claves VAPID validas y se pueden mandar notificaciones. */
export function pushHabilitado() {
  return motivoDeshabilitado === null;
}

/** La clave publica VAPID, o null si el push esta desactivado. */
export function clavePublica() {
  return pushHabilitado() ? clavePublicaVapid : null;
}

/**
 * Manda una notificacion a una suscripcion.
 *
 * A diferencia de `enviarCorreo`, esta si tira: quien llama necesita el
 * `statusCode` del error para distinguir una suscripcion vencida (404/410, se
 * borra) de una falla pasajera (se loguea). Ese manejo vive en el service.
 *
 * @param {{endpoint: string, p256dh: string, auth: string}} suscripcion
 * @param {object} contenido se manda como JSON
 */
export async function enviarPush(suscripcion, contenido) {
  if (!pushHabilitado()) {
    return;
  }

  await webpush.sendNotification(
    {
      endpoint: suscripcion.endpoint,
      keys: { p256dh: suscripcion.p256dh, auth: suscripcion.auth },
    },
    JSON.stringify(contenido),
    { TTL: TTL_SEGUNDOS },
  );
}
