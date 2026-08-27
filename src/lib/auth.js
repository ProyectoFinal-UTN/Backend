import "dotenv/config";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { db } from "../db/client.js";
import * as schema from "../db/schema.js";
import { ac, roles, ROLES } from "./permissions.js";

const PORT = process.env.PORT || 4000;

/**
 * Configuración central de Better Auth.
 *
 * Modelo multi-tenant: cada comercio es una ORGANIZATION de Better Auth, y la
 * tabla propia `comercio` le cuelga los datos del negocio 1:1 (ver
 * references/data-model.md). El rol vive en MEMBER, no en una tabla aparte.
 */
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || `http://localhost:${PORT}`,
  trustedOrigins: (process.env.TRUSTED_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  emailAndPassword: {
    enabled: true,
    // RNF4: hash fuerte. Better Auth usa scrypt por defecto (no bcrypt);
    // la decisión de algoritmo se cierra en HU-1.
    minPasswordLength: 8,
    autoSignIn: false,
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
