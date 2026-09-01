import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { movimiento, producto, stock, ubicacion } from "../db/schema.js";
import { ErrorDeNegocio, esUuid } from "../lib/errores.js";

/**
 * Logica de negocio del registro de movimientos de stock (HU-13).
 *
 * Toda funcion recibe `comercioId` primero y lo usa en el WHERE/INSERT. Ese
 * valor sale siempre de la sesion (lo pone `requireAuth`), nunca del body ni de
 * la query string.
 *
 * El modelo es hibrido (ver references/data-model.md): MOVIMIENTO es el libro
 * append-only y fuente de verdad, STOCK es la cache del saldo por
 * (producto, ubicacion). Las dos escrituras van siempre en la misma
 * transaccion, y `aplicarMovimiento` es el unico lugar del repo que las hace.
 */

/**
 * Signo con el que cada tipo impacta el saldo.
 *
 * `ajuste` no esta aca a proposito: es el unico tipo que puede ir para los dos
 * lados (una correccion de inventario tanto suma como resta), asi que su signo
 * lo define el campo `sentido` del body. `transferencia` tampoco: esas filas
 * las crea el flujo de HU-12 en pares ligados, no este endpoint.
 */
const SIGNO_POR_TIPO = { compra: +1, venta: -1, merma: -1 };

const TIPOS_ACEPTADOS = [...Object.keys(SIGNO_POR_TIPO), "ajuste"];
const SENTIDOS_VALIDOS = { entrada: +1, salida: -1 };

/** Maximo de un `integer` de Postgres, que es el tipo de `cantidad`. */
const CANTIDAD_MAXIMA = 2147483647;

/**
 * Valida y normaliza los datos de un movimiento.
 *
 * Es pura y no toca la base, para poder testearla sola (igual que
 * `validarDatosProducto`). Devuelve un objeto nuevo con solo los campos
 * conocidos: si el cliente manda un `comercioId` o un `usuarioId` en el body,
 * se pierden aca — esos dos salen siempre de la sesion.
 *
 * `cantidad` se recibe siempre como magnitud positiva y se devuelve ya con el
 * signo que le corresponde al tipo, que es como se guarda en la tabla.
 */
export function validarDatosMovimiento(datosCrudos = {}) {
  if (!esUuid(datosCrudos.productoId)) {
    throw new ErrorDeNegocio("El producto indicado no es válido", 400);
  }

  const tipo =
    typeof datosCrudos.tipo === "string"
      ? datosCrudos.tipo.trim().toLowerCase()
      : "";

  if (!TIPOS_ACEPTADOS.includes(tipo)) {
    throw new ErrorDeNegocio(
      `El tipo de movimiento no es válido. Los aceptados son: ${TIPOS_ACEPTADOS.join(", ")}`,
      400,
    );
  }

  // Mismo criterio que `esEnteroNoNegativo` en productos.service.js, para que
  // los dos modulos entiendan lo mismo por "numero valido":
  //
  // - `typeof number` en vez de `Number(...)`: la coercion convierte `true` en
  //   1 y `[3]` en 3, asi que un campo mal serializado entraria como un
  //   movimiento real en un libro que despues no se puede editar.
  // - El tope tiene que estar aca y no solo en la base: `movimiento.cantidad`
  //   es un integer de Postgres, y un valor mas grande falla en el INSERT con
  //   22003, que sale como 500 en vez del 400 que corresponde.
  const cantidad = datosCrudos.cantidad;
  if (
    typeof cantidad !== "number" ||
    !Number.isInteger(cantidad) ||
    cantidad <= 0 ||
    cantidad > CANTIDAD_MAXIMA
  ) {
    throw new ErrorDeNegocio(
      `La cantidad debe ser un número entero entre 1 y ${CANTIDAD_MAXIMA}`,
      400,
    );
  }

  let signo = SIGNO_POR_TIPO[tipo];

  if (tipo === "ajuste") {
    const sentido =
      typeof datosCrudos.sentido === "string"
        ? datosCrudos.sentido.trim().toLowerCase()
        : "";

    signo = SENTIDOS_VALIDOS[sentido];

    if (!signo) {
      throw new ErrorDeNegocio(
        'Un ajuste requiere indicar el sentido: "entrada" o "salida"',
        400,
      );
    }
  }

  const datos = {
    productoId: datosCrudos.productoId,
    tipo,
    cantidad: signo * cantidad,
    proveedorId: null,
    ubicacionId: undefined,
  };

  if (datosCrudos.proveedorId !== undefined && datosCrudos.proveedorId !== null) {
    if (!esUuid(datosCrudos.proveedorId)) {
      throw new ErrorDeNegocio("El proveedor indicado no es válido", 400);
    }
    datos.proveedorId = datosCrudos.proveedorId;
  }

  if (datosCrudos.ubicacionId !== undefined && datosCrudos.ubicacionId !== null) {
    if (!esUuid(datosCrudos.ubicacionId)) {
      // 404 y no 400: para este comercio esa ubicacion no existe, que es el
      // mismo resultado que si el UUID fuera valido pero de otro comercio.
      throw new ErrorDeNegocio("La ubicación no existe", 404);
    }
    datos.ubicacionId = datosCrudos.ubicacionId;
  }

  return datos;
}

/**
 * Verifica que el producto exista, sea de este comercio y no este dado de baja.
 *
 * El filtro por `activo` importa: HU-9 borra logicamente, y registrar un
 * movimiento sobre un producto eliminado reviviria su stock sin que el producto
 * vuelva a aparecer en ningun listado.
 */
async function exigirProductoDelComercio(tx, comercioId, productoId) {
  const [fila] = await tx
    .select({ id: producto.id })
    .from(producto)
    .where(
      and(
        eq(producto.id, productoId),
        eq(producto.comercioId, comercioId),
        eq(producto.activo, true),
      ),
    )
    .limit(1);

  if (!fila) {
    throw new ErrorDeNegocio("El producto no existe", 404);
  }

  return fila.id;
}

/**
 * Resuelve la ubicacion del movimiento.
 *
 * Si el comercio tiene una sola ubicacion, no hace falta mandarla: el flujo de
 * registro no deberia pedir un dato que no tiene alternativa (RNF1, ~3 pasos).
 * Con varias, es obligatoria — elegir una por el cliente seria adivinar de que
 * estante sale la mercaderia.
 *
 * A diferencia de `resolverUbicacionParaAlta` (productos.service.js), aca no se
 * crea ninguna ubicacion por defecto: crear una "Principal" como efecto
 * secundario de registrar una venta seria una sorpresa, y sin ubicaciones
 * tampoco puede haber stock que mover.
 */
async function resolverUbicacion(tx, comercioId, ubicacionId) {
  if (ubicacionId) {
    const [existente] = await tx
      .select({ id: ubicacion.id })
      .from(ubicacion)
      .where(
        and(eq(ubicacion.id, ubicacionId), eq(ubicacion.comercioId, comercioId)),
      )
      .limit(1);

    if (!existente) {
      // 404 y no 403: decir "existe pero no es tuya" filtraria informacion de
      // otro comercio (mismo criterio que ubicaciones.service.js).
      throw new ErrorDeNegocio("La ubicación no existe", 404);
    }

    return existente.id;
  }

  const ubicaciones = await tx
    .select({ id: ubicacion.id })
    .from(ubicacion)
    .where(eq(ubicacion.comercioId, comercioId))
    .limit(2);

  if (ubicaciones.length === 0) {
    throw new ErrorDeNegocio(
      "El comercio no tiene ubicaciones configuradas",
      400,
    );
  }

  if (ubicaciones.length > 1) {
    throw new ErrorDeNegocio(
      "Se requiere indicar la ubicación: el comercio tiene más de una",
      400,
    );
  }

  return ubicaciones[0].id;
}

/**
 * Inserta el movimiento y actualiza la cache de stock, dentro de la transaccion
 * que recibe.
 *
 * Es la unica funcion del repo que escribe en `stock`: mientras todo pase por
 * aca, el invariante STOCK.cantidad = SUM(MOVIMIENTO.cantidad) se sostiene
 * solo. La usan el endpoint de HU-13, el alta de productos de HU-9 (para el
 * stock inicial) y, cuando exista, cada pata de la transferencia de HU-12.
 *
 * `cantidad` ya viene con signo: entrada +, salida -.
 */
export async function aplicarMovimiento(
  tx,
  {
    comercioId,
    productoId,
    ubicacionId,
    usuarioId,
    tipo,
    cantidad,
    proveedorId = null,
    transferenciaId = null,
  },
) {
  // El FOR UPDATE bloquea la fila de stock hasta el fin de la transaccion. Sin
  // el, dos ventas simultaneas de las ultimas unidades leerian ambas el mismo
  // saldo, pasarian ambas la validacion de abajo y dejarian el stock en
  // negativo. Es la misma clase de carrera que ya se cuido en
  // `resolverUbicacionParaAlta` y en `traducirDuplicado`.
  const [filaStock] = await tx
    .select({ cantidad: stock.cantidad })
    .from(stock)
    .where(
      and(
        eq(stock.productoId, productoId),
        eq(stock.ubicacionId, ubicacionId),
        eq(stock.comercioId, comercioId),
      ),
    )
    .for("update")
    .limit(1);

  // Sin fila de stock el disponible es 0, asi que cualquier salida se rechaza.
  // Solo una entrada puede crear la fila, y las entradas no pasan por aca.
  const disponible = filaStock?.cantidad ?? 0;

  // `disponible + cantidad < 0` y no `disponible < cantidad`: asi vale igual
  // para el ajuste negativo, que tambien es una salida. Descontar exactamente
  // lo disponible (queda en 0) tiene que pasar.
  if (cantidad < 0 && disponible + cantidad < 0) {
    throw new ErrorDeNegocio(
      `Stock insuficiente: hay ${disponible} unidades disponibles y se intentan descontar ${-cantidad}`,
      409,
    );
  }

  // El tope de una entrada sola no alcanza: es el SALDO el que tiene que entrar
  // en el integer de `stock.cantidad`. Sin este chequeo, una entrada valida
  // sobre un stock ya alto desborda en el upsert con 22003 y sale como 500.
  // Es 409 y no 400 por lo mismo que el stock insuficiente: el dato es valido,
  // lo que no entra es el resultado contra el estado actual.
  if (cantidad > 0 && disponible + cantidad > CANTIDAD_MAXIMA) {
    throw new ErrorDeNegocio(
      `El stock resultante superaria el maximo de ${CANTIDAD_MAXIMA} unidades: hay ${disponible} y se intentan sumar ${cantidad}`,
      409,
    );
  }

  const [movimientoCreado] = await tx
    .insert(movimiento)
    .values({
      comercioId,
      productoId,
      ubicacionId,
      usuarioId,
      tipo,
      cantidad,
      proveedorId,
      transferenciaId,
    })
    .returning();

  // Upsert sobre `stock_producto_ubicacion_uidx`. La suma va en SQL y no en JS
  // para no pisar con un valor leido antes lo que haya escrito otra
  // transaccion.
  const [stockActualizado] = await tx
    .insert(stock)
    .values({ comercioId, productoId, ubicacionId, cantidad })
    .onConflictDoUpdate({
      target: [stock.productoId, stock.ubicacionId],
      set: {
        cantidad: sql`${stock.cantidad} + ${cantidad}`,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: stock.id,
      ubicacionId: stock.ubicacionId,
      cantidad: stock.cantidad,
    });

  return { movimiento: movimientoCreado, stock: stockActualizado };
}

/**
 * Registra un movimiento de entrada o salida y actualiza el stock (HU-13).
 *
 * Todo pasa dentro de una unica transaccion: si la actualizacion del stock
 * falla, el movimiento no queda insertado.
 */
export async function registrarMovimiento(
  comercioId,
  usuarioId,
  datosCrudos = {},
) {
  const datos = validarDatosMovimiento(datosCrudos);

  return db.transaction(async (tx) => {
    const productoId = await exigirProductoDelComercio(
      tx,
      comercioId,
      datos.productoId,
    );
    const ubicacionId = await resolverUbicacion(
      tx,
      comercioId,
      datos.ubicacionId,
    );

    return aplicarMovimiento(tx, {
      comercioId,
      productoId,
      ubicacionId,
      usuarioId,
      tipo: datos.tipo,
      cantidad: datos.cantidad,
      proveedorId: datos.proveedorId,
    });
  });
}
