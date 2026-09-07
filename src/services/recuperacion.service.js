import { enviarCorreo } from "../lib/correo.js";

/**
 * Recuperacion de contrasena (HU-3).
 *
 * El ciclo del token —generarlo, guardarlo, validarlo, vencerlo— lo maneja
 * Better Auth: expone `POST /api/auth/forget-password` y
 * `POST /api/auth/reset-password`, y llama a `sendResetPassword` con el token
 * ya creado. Lo que falta y va aca es el correo: a donde apunta el link y que
 * dice.
 */

/** Cuanto vive el link antes de vencer. Se declara tambien en `auth.js`. */
export const MINUTOS_DE_VIGENCIA = 60;

/**
 * A donde apunta el link del correo.
 *
 * Va al Frontend, no al backend. Better Auth ofrece una `url` propia que pasa
 * por el backend y de ahi redirige, pero eso agrega un salto que no aporta
 * nada: la pantalla que pide la contrasena nueva vive en el Frontend, asi que
 * el link va derecho ahi con el token. Es para esto que Better Auth entrega el
 * `token` por separado.
 *
 * Si no hay `FRONTEND_URL`, se usa el primero de los origenes de confianza: el
 * Frontend es, por definicion, uno de ellos.
 */
function baseDelFrontend() {
  if (process.env.FRONTEND_URL) {
    return process.env.FRONTEND_URL.replace(/\/$/, "");
  }

  const [primero] = (process.env.TRUSTED_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((origen) => origen.trim())
    .filter(Boolean);

  return (primero || "http://localhost:5173").replace(/\/$/, "");
}

export function armarLinkDeRecuperacion(token) {
  return `${baseDelFrontend()}/restablecer?token=${encodeURIComponent(token)}`;
}

/**
 * El correo, en texto y en HTML.
 *
 * Los dos dicen lo mismo: hay clientes que no muestran HTML, y un correo que
 * llega vacio es peor que uno feo. El link aparece completo tambien como texto
 * porque algunos clientes no lo hacen clickeable.
 */
export function armarCorreoDeRecuperacion({ correo, link }) {
  const texto = [
    "Pediste recuperar la contraseña de tu cuenta.",
    "",
    "Entrá acá para elegir una nueva:",
    link,
    "",
    `El link vence en ${MINUTOS_DE_VIGENCIA} minutos y se puede usar una sola vez.`,
    "",
    "Si no lo pediste vos, ignorá este correo: tu contraseña no cambia hasta " +
      "que alguien entre por ese link.",
  ].join("\n");

  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; line-height: 1.6;">
      <h1 style="font-size: 20px;">Recuperar tu contraseña</h1>
      <p>Pediste recuperar la contraseña de la cuenta <strong>${correo}</strong>.</p>
      <p>
        <a href="${link}"
           style="display: inline-block; padding: 12px 20px; border-radius: 12px;
                  background: #1f7a3f; color: #fff; text-decoration: none;
                  font-weight: bold;">
          Elegir una nueva contraseña
        </a>
      </p>
      <p style="font-size: 14px; color: #555;">
        Si el botón no funciona, copiá y pegá este link:<br />
        <span style="word-break: break-all;">${link}</span>
      </p>
      <p style="font-size: 14px; color: #555;">
        El link vence en ${MINUTOS_DE_VIGENCIA} minutos y se puede usar una sola vez.
      </p>
      <p style="font-size: 14px; color: #555;">
        Si no lo pediste vos, ignorá este correo: tu contraseña no cambia hasta
        que alguien entre por ese link.
      </p>
    </div>
  `.trim();

  return { asunto: "Recuperá tu contraseña", texto, html };
}

/** Manda el correo con el link. No tira: ver `lib/correo.js`. */
export async function enviarRecuperacion({ correo, token }) {
  const link = armarLinkDeRecuperacion(token);
  const { asunto, texto, html } = armarCorreoDeRecuperacion({ correo, link });

  return enviarCorreo({ para: correo, asunto, texto, html });
}
