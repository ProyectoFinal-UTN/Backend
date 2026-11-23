import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool);

/**
 * Una conexion inactiva que se corta NO puede tirar abajo el servidor.
 *
 * Neon cierra del lado del servidor las conexiones que quedan quietas (al
 * suspender el compute, o su proxy por inactividad). `pg` avisa emitiendo
 * `error` en el pool, y un `error` sin nadie escuchando es una excepcion no
 * manejada: el proceso entero se cae con "Connection terminated unexpectedly".
 * Paso de verdad corriendo los E2E de HU-22 —el backend quedo caido y Nginx
 * contestaba 502— y en Render pasaria igual, solo que reiniciando.
 *
 * Alcanza con escuchar: el pool ya descarto esa conexion y abre otra en el
 * proximo pedido. Se loguea para que se vea en los logs, sin el objeto entero.
 * Es la recomendacion de la documentacion de node-postgres.
 */
pool.on("error", (error) => {
  console.error("[db] conexion inactiva cerrada por el servidor:", error.message);
});

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
