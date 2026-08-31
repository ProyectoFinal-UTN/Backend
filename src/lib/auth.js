import "dotenv/config";
import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { crearComercioParaPropietario } from "../services/comercios.service.js";
import { ac, roles, ROLES } from "./permissions.js";

const PORT = process.env.PORT || 4000;

/** Coste de bcrypt. 12 rondas es el equilibrio habitual hoy entre seguridad y latencia. */
const BCRYPT_ROUNDS = 12;

/**
 * Exige que el secreto de sesiones exista y sea razonable, y corta el arranque
 * si no.
 *
 * Sin esto el fallo es silencioso y peligroso: si falta `BETTER_AUTH_SECRET`,
 * Better Auth no deja el secreto vacío sino que cae en uno hardcodeado que está
 * publicado en el código fuente de la librería, y solo se niega a arrancar si
 * `NODE_ENV === "production"` — que en nuestra imagen de Docker no está
 * definido. El backend levantaría sin errores y con las sesiones firmadas por
 * un secreto que cualquiera puede leer en GitHub.
 */
function exigirSecreto() {
  // Los tests no dependen de la configuración de la máquina que los corre.
  if (process.env.NODE_ENV === "test") {
    return "secreto-solo-para-tests-no-usar-fuera-de-jest";
  }

  const secreto = process.env.BETTER_AUTH_SECRET;

  if (!secreto) {
    throw new Error(
      "Falta BETTER_AUTH_SECRET. Copiá .env.example a .env y generá una con: openssl rand -base64 32",
    );
  }

  if (secreto.length < 32) {
    throw new Error(
      `BETTER_AUTH_SECRET es demasiado corta (${secreto.length} caracteres, mínimo 32). Generá una con: openssl rand -base64 32`,
    );
  }

  return secreto;
}

/**
 * Configuración central de Better Auth.
 *
 * Modelo multi-tenant: cada comercio es una ORGANIZATION de Better Auth, y la
 * tabla propia `comercio` le cuelga los datos del negocio 1:1 (ver
 * references/data-model.md). El rol vive en MEMBER, no en una tabla aparte.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: exigirSecreto(),
  baseURL: process.env.BETTER_AUTH_URL || `http://localhost:${PORT}`,
  trustedOrigins: (process.env.TRUSTED_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,

    // `autoSignIn` queda en su default (true) a propósito.
    //
    // Con `autoSignIn: false`, Better Auth responde a un registro con correo
    // repetido devolviendo un usuario sintético y 200, para no revelar qué
    // correos existen. Es buena práctica de seguridad, pero HU-1 pide
    // explícitamente que el sistema "no permita registrar un correo ya
    // existente y muestre un mensaje claro", y con esa respuesta genérica el
    // criterio no se puede cumplir. Dejándolo en true, el duplicado devuelve
    // 422 con USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL.
    //
    // El efecto secundario es que el registro deja la sesión iniciada, que
    // además es la UX que se espera después de crear la cuenta.
    // HU-1 pide explícitamente bcrypt (RNF4). Better Auth usa scrypt por
    // defecto, así que se enchufa el hasher propio. Cambiar esto más adelante
    // invalidaría las contraseñas ya guardadas.
    password: {
      hash: (password) => bcrypt.hash(password, BCRYPT_ROUNDS),
      verify: ({ hash, password }) => bcrypt.compare(password, hash),
    },
  },

  databaseHooks: {
    user: {
      create: {
        // Un usuario recién registrado todavía no es propietario de nada:
        // sin organization no hay tenant, sin member no hay rol, y sin
        // comercio `requireAuth` lo rechaza con 403. Las tres se crean acá,
        // en una transacción, apenas nace el usuario (HU-1).
        after: async (user) => {
          await crearComercioParaPropietario({
            userId: user.id,
            email: user.email,
          });
        },
      },
    },
  },

  session: {
    // Expiración por inactividad (HU-2): la sesión vive 8 horas desde la
    // última actividad, y se renueva como mucho una vez por hora.
    expiresIn: 60 * 60 * 8,
    updateAge: 60 * 60,
  },

  plugins: [
    organization({
      ac,
      roles,
      creatorRole: ROLES.PROPIETARIO,
    }),
  ],
});
