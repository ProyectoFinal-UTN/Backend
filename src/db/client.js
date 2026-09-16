import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool);

/**
 * Cierra el pool de conexiones.
 *
 * En el servidor no hace falta llamarla: el pool vive lo que vive el proceso.
 * Existe para los tests de integracion, que si no dejan el handle abierto y
 * Jest tiene que matar el worker a la fuerza.
 */
export async function cerrarConexion() {
  await pool.end();
}
