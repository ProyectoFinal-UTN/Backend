import { and, eq, sql } from "drizzle-orm";
import { alerta, producto, stock } from "../db/schema.js";

/**
 * Alertas de reposicion (HU-17).
 *
 * Una alerta nace y se cierra DENTRO de la misma transaccion que actualiza
 * `stock`: `aplicarMovimiento` (movimientos.service.js) llama a
 * `evaluarAlertaDeStock` con su propio `tx` como ultimo paso, y
 * `actualizarUmbral` (productos.service.js) hace lo mismo. No hay transaccion
 * propia, ni job, ni listener: si la evaluacion falla, el movimiento que la
 * origino se revierte con ella, que es exactamente lo que tiene que pasar —una
 * alerta que no se pudo escribir no puede quedar como un faltante invisible.
 *
 * El `comercioId` llega primero y sale siempre de la sesion, nunca del body.
 *
 * El listado que consume el dashboard esta en alertasActivas.service.js, y no
 * aca, para no armar un ciclo de imports: `movimientos.service.js` importa
 * este modulo, y el listado necesita los lectores de paginacion de
 * `movimientos.service.js`.
 *
 * ---------------------------------------------------------------------------
 * LIMITACION CONOCIDA: las alertas se evaluan cuando pasa algo, no en segundo
 * plano.
 *
 * Los dos disparadores son mover stock y cambiar el umbral. Un producto creado
 * con stock inicial 0 y umbral configurado no entra por ninguno de los dos
 * —`crearProducto` solo llama a `aplicarMovimiento` cuando el stock inicial es
 * mayor que 0— y no genera alerta hasta su primer movimiento o hasta que se le
 * vuelva a tocar el umbral. No se fuerza un movimiento de 0 unidades para
 * taparlo: ensuciaria el libro de HU-13, que es la fuente de verdad del
 * inventario.
 * ---------------------------------------------------------------------------
 */

/**
 * Si un producto esta en situacion de reponer.
 *
 * Pura, sin base, para testearla sola. Es LA definicion de la HU y la unica
 * que se compara contra el umbral en todo el flujo.
 *
 * `<=` y no `<`: el criterio de aceptacion dice "los productos que alcanzaron
 * su umbral minimo", y alcanzar es llegar, no pasar. Quedar justo en el umbral
 * ya es tener que reponer. Es tambien el criterio que ya usaban
 * `productosParaReponer` (asistente.consultas.service.js) y el push de HU-18,
 * y que el dashboard tiene que compartir para no decir una cosa distinta sobre
 * el mismo producto.
 *
 * Umbral 0 es "sin umbral configurado" (HU-16), no "avisame cuando me quede
 * sin nada": ahi no se alerta nunca, aunque el stock sea 0.
 */
export function hayQueReponer({ enStock, umbralMinimo }) {
  return umbralMinimo > 0 && enStock <= umbralMinimo;
}

/**
 * Stock total del comercio y umbral de un producto, dentro de la transaccion.
 *
 * Suma todas las ubicaciones y no mira la fila de `stock` que se acaba de
 * tocar: tener el umbral cubierto entre el deposito y el salon significa que no
 * hay que comprar, aunque en el salon no quede nada. Mover entre ubicaciones es
 * otro problema y lo resuelve la transferencia de HU-12. Mismo criterio que
 * `productosParaReponer`.
 *
 * Corre con el `tx` y no con `db`, asi que ve la escritura de stock que esa
 * misma transaccion acaba de hacer y todavia no commiteo.
 *
 * Un producto inactivo (borrado logico de HU-9) devuelve `null`: no se le
 * generan alertas nuevas.
 */
async function leerSituacion(tx, comercioId, productoId) {
  const [fila] = await tx
    .select({
      nombre: producto.nombre,
      umbralMinimo: producto.umbralMinimo,
      enStock: sql`coalesce(sum(${stock.cantidad}), 0)`.mapWith(Number),
    })
    .from(producto)
    .leftJoin(
      stock,
      and(eq(stock.productoId, producto.id), eq(stock.comercioId, comercioId)),
    )
    .where(
      and(
        eq(producto.id, productoId),
        eq(producto.comercioId, comercioId),
        eq(producto.activo, true),
      ),
    )
    .groupBy(producto.id, producto.nombre, producto.umbralMinimo);

  return fila ?? null;
}

/**
 * Abre o cierra la alerta de un producto segun como quedo su stock.
 *
 * Se llama al final de la transaccion que movio el stock (o que cambio el
 * umbral), con el `tx` de esa transaccion.
 *
 * Evalua ESTADO y no transicion ("venia de arriba y quedo abajo"), que es lo
 * que hacia el push de HU-18 antes de esta HU. La transicion tiene un agujero
 * que el stock por ubicacion hace alcanzable: umbral 10, stock 20 repartido
 * 10 y 10 entre dos ubicaciones, dos ventas de 5 a la vez. El FOR UPDATE de
 * `aplicarMovimiento` bloquea filas de `stock` DISTINTAS, asi que las dos
 * transacciones corren en paralelo y cada una ve un total de 15: ninguna
 * detecta el cruce. El total real queda en 10 y, como de ahi en adelante el
 * saldo previo ya esta por debajo, la condicion de transicion no vuelve a
 * dispararse nunca y ese producto no alerta mas. Mirando el estado, la alerta
 * aparece en el primer movimiento que termine debajo del umbral y el sistema
 * converge solo.
 *
 * El anti-duplicado no esta aca sino en `alerta_producto_activa_uidx`, el
 * indice unico parcial (ver db/schema.js). Un `select` previo seria un TOCTOU:
 * nada bloquea a dos transacciones concurrentes de leer las dos "no hay alerta
 * activa" e insertar las dos. `onConflictDoNothing` y no dejar que tire 23505
 * porque un error de unique aborta la transaccion ENTERA, y se llevaria puesto
 * un movimiento que es perfectamente valido.
 *
 * @returns {Promise<null | {
 *   nueva: boolean, resuelta: boolean, id: string | null, productoId: string,
 *   nombre: string, stockActual: number, umbralMinimo: number
 * }>} `null` si el producto no existe en el comercio o esta inactivo.
 *   `nueva: true` es el evento "este producto acaba de entrar en falta": es lo
 *   que mira el push de HU-18 para no avisar dos veces lo mismo, y de lo que se
 *   tiene que colgar cualquier otro consumidor futuro.
 */
export async function evaluarAlertaDeStock(
  tx,
  { comercioId, productoId, movimientoId = null },
) {
  const situacion = await leerSituacion(tx, comercioId, productoId);

  if (!situacion) {
    return null;
  }

  const comun = {
    productoId,
    nombre: situacion.nombre,
    stockActual: situacion.enStock,
    umbralMinimo: situacion.umbralMinimo,
  };

  if (hayQueReponer(situacion)) {
    const [creada] = await tx
      .insert(alerta)
      .values({
        comercioId,
        productoId,
        movimientoId,
        stockAlGenerar: situacion.enStock,
        umbralAlGenerar: situacion.umbralMinimo,
      })
      // El `where` repite el predicado del indice parcial, y no es opcional:
      // sin el, Postgres no sabe que indice usar para inferir el conflicto y
      // tira "there is no unique or exclusion constraint matching the ON
      // CONFLICT specification". En `onConflictDoNothing` la clave es `where`
      // (`targetWhere` solo existe en `onConflictDoUpdate`), y lo que emite es
      // justo la clausula de inferencia: `(producto_id) where ... do nothing`.
      .onConflictDoNothing({
        target: alerta.productoId,
        where: eq(alerta.estado, "activa"),
      })
      .returning({ id: alerta.id });

    // Sin fila devuelta el indice freno el insert: ya habia una activa, asi
    // que el producto sigue en falta pero no es una novedad y no se vuelve a
    // notificar. No se relee cual es: nadie necesita su id.
    return { ...comun, nueva: Boolean(creada), resuelta: false, id: creada?.id ?? null };
  }

  // Volvio a estar por encima del umbral (o le sacaron el umbral): se cierra
  // la que hubiera activa. La fila no se borra —data-model.md pide el ciclo
  // activa -> resuelta— y el indice parcial deja que el producto vuelva a
  // alertar mas adelante, porque solo exige unicidad entre las activas.
  const [cerrada] = await tx
    .update(alerta)
    .set({ estado: "resuelta", resueltaEn: new Date() })
    .where(
      and(
        eq(alerta.comercioId, comercioId),
        eq(alerta.productoId, productoId),
        eq(alerta.estado, "activa"),
      ),
    )
    .returning({ id: alerta.id });

  return { ...comun, nueva: false, resuelta: Boolean(cerrada), id: cerrada?.id ?? null };
}
