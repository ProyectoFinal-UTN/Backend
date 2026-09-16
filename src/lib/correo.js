import { Resend } from "resend";

/**
 * Envio de correos (HU-3).
 *
 * Un solo lugar habla con el proveedor. Si mañana se cambia Resend por otro,
 * se toca este archivo y nada más.
 *
 * ## Por que hay un modo de respaldo que escribe en consola
 *
 * Resend no deja mandarle a cualquier direccion hasta tener un dominio propio
 * verificado: sin dominio, solo acepta la casilla con la que se registro la
 * cuenta. Todavia no tenemos dominio, asi que si el envio fuera lo unico que
 * hay, la recuperacion de contrasena solo se podria probar con una cuenta y el
 * flujo quedaria a medias para el resto del equipo.
 *
 * Por eso, cuando el envio no es posible —no hay clave configurada, o Resend
 * rechaza la direccion— el correo no se pierde: se escribe entero en la
 * consola del backend, con el link adentro. El flujo se puede seguir de punta a
 * punta con cualquier cuenta de prueba.
 *
 * El dia que haya dominio verificado se saca `registrarEnConsola` y no hace
 * falta tocar nada mas: el resto del codigo ya llama a `enviarCorreo` sin saber
 * cual de los dos caminos se tomo.
 *
 * ## Lo que esta funcion nunca hace
 *
 * No tira. Que falle un correo no puede romper la operacion que lo disparo: en
 * la recuperacion de contrasena, un error de envio propagado le diria a quien
 * lo pidio si ese correo existe o no, que es justamente lo que no se puede
 * revelar. Devuelve si pudo o no, y quien llama decide.
 */

const clave = process.env.RESEND_API_KEY;

/**
 * Remitente. `onboarding@resend.dev` es la casilla de prueba de Resend, que
 * funciona sin dominio verificado. Se reemplaza por uno propio cuando lo haya.
 */
const REMITENTE = process.env.CORREO_REMITENTE || "Stock <onboarding@resend.dev>";

const resend = clave ? new Resend(clave) : null;

/** Escribe el correo en la consola, para poder seguir el flujo sin envio real. */
function registrarEnConsola({ para, asunto, texto, motivo }) {
  console.warn(
    [
      "",
      "─".repeat(70),
      `[correo] NO se envió (${motivo}). Va el contenido para poder seguir:`,
      `  Para:   ${para}`,
      `  Asunto: ${asunto}`,
      "",
      texto,
      "─".repeat(70),
      "",
    ].join("\n"),
  );
}

/**
 * Manda un correo, o lo deja en la consola si no se puede.
 *
 * @param {{para: string, asunto: string, html: string, texto: string}} correo
 * @returns {Promise<{enviado: boolean, motivo?: string}>}
 */
export async function enviarCorreo({ para, asunto, html, texto }) {
  if (!resend) {
    registrarEnConsola({
      para,
      asunto,
      texto,
      motivo: "falta RESEND_API_KEY en el .env",
    });

    return { enviado: false, motivo: "sin-clave" };
  }

  try {
    const { error } = await resend.emails.send({
      from: REMITENTE,
      to: para,
      subject: asunto,
      html,
      text: texto,
    });

    if (error) {
      // El caso tipico mientras no haya dominio: Resend responde 403 porque la
      // direccion no es la de la cuenta. No es un bug, es el limite del plan
      // sin dominio verificado.
      registrarEnConsola({ para, asunto, texto, motivo: error.message });

      return { enviado: false, motivo: error.message };
    }

    return { enviado: true };
  } catch (fallo) {
    // Red caida, timeout, o Resend con problemas. Tampoco se pierde el correo.
    registrarEnConsola({ para, asunto, texto, motivo: fallo.message });

    return { enviado: false, motivo: fallo.message };
  }
}
