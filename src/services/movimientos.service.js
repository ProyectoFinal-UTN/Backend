import { and, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  movimiento,
  producto,
  stock,
  tipoMovimiento,
  ubicacion,
  user,
} from "../db/schema.js";
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

/**
 * Tipos que no se entienden sin una explicacion escrita (HU-15).
 *
 * Una compra o una venta se explican solas: hubo una operacion comercial
 * detras. Un ajuste y una merma, no — son la correccion de una diferencia
 * entre el stock del sistema y el real, y sin el motivo el libro dice que
 * faltan seis unidades pero no por que. Ese "por que" es lo que hace auditable
 * la correccion.
 */
const TIPOS_QUE_EXIGEN_MOTIVO = ["ajuste", "merma"];

/**
 * Largo de `movimiento.motivo`, que es un varchar(255).
 *
 * Exportada para que transferencias.service.js (HU-12) valide contra el mismo
 * limite y devuelva el mismo mensaje, en vez de repetir el numero.
 */
export const MOTIVO_MAXIMO = 255;

/** Maximo de un `integer` de Postgres, que es el tipo de `cantidad`. */
export const CANTIDAD_MAXIMA = 2147483647;

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

  // El motivo se recorta antes de medirlo: "   " es una cadena no vacia para
  // JavaScript, pero no es un motivo. Mismo criterio de trim que el tipo y el
  // sentido de arriba.
  const motivoCrudo =
    typeof datosCrudos.motivo === "string" ? datosCrudos.motivo.trim() : "";

  if (TIPOS_QUE_EXIGEN_MOTIVO.includes(tipo) && motivoCrudo === "") {
    throw new ErrorDeNegocio(
      `Un movimiento de tipo "${tipo}" requiere indicar el motivo`,
      400,
    );
  }

  // El tope tiene que estar aca y no solo en la base, por lo mismo que la
  // cantidad: un texto mas largo falla en el INSERT con 22001, que sale como
  // 500 en vez del 400 que corresponde.
  if (motivoCrudo.length > MOTIVO_MAXIMO) {
    throw new ErrorDeNegocio(
      `El motivo no puede superar los ${MOTIVO_MAXIMO} caracteres`,
      400,
    );
  }

  const datos = {
    productoId: datosCrudos.productoId,
    tipo,
    cantidad: signo * cantidad,
    // null y no "" cuando no viene: la columna es nullable, y una cadena vacia
    // guardada seria un motivo que existe y no dice nada.
    motivo: motivoCrudo === "" ? null : motivoCrudo,
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
 *
 * Exportada: la transferencia de HU-12 hace exactamente la misma verificacion
 * y tiene que devolver el mismo 404.
 */
export async function exigirProductoDelComercio(tx, comercioId, productoId) {
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
 *
 * Exportada: la transferencia de HU-12 la usa dos veces, siempre con el id
 * explicito (origen y destino son obligatorios ahi, no se infiere ninguno).
 */
export async function resolverUbicacion(tx, comercioId, ubicacionId) {
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
    motivo = null,
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
      motivo,
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
      motivo: datos.motivo,
      proveedorId: datos.proveedorId,
    });
  });
}

/* ---------------------------------------------------------------------------
 * Historial de movimientos (HU-14)
 * ------------------------------------------------------------------------- */

/**
 * Los cinco tipos del enum, `transferencia` incluida: el historial muestra todo
 * lo que hay en el libro, no solo lo que se puede registrar por HU-13.
 */
const TIPOS_DEL_HISTORIAL = tipoMovimiento.enumValues;

const LIMITE_HISTORIAL_POR_DEFECTO = 50;
const LIMITE_HISTORIAL_MAXIMO = 200;

/**
 * Fecha y hora ISO 8601 con zona explicita (`Z` u offset).
 *
 * Se exige la zona a proposito: "del 10 al 12" depende de donde este parado el
 * usuario. Un movimiento de las 22 h en Argentina se guarda al dia siguiente en
 * UTC, asi que el que sabe donde empieza y termina "su" dia es el cliente, y
 * manda los limites ya resueltos como instantes.
 */
const FORMATO_INSTANTE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function leerInstante(valor, nombre) {
  if (valor === undefined || valor === null || valor === "") {
    return undefined;
  }

  const fecha =
    typeof valor === "string" && FORMATO_INSTANTE.test(valor)
      ? new Date(valor)
      : null;

  if (!fecha || Number.isNaN(fecha.getTime())) {
    throw new ErrorDeNegocio(
      `El parámetro "${nombre}" debe ser una fecha y hora ISO 8601 con zona, por ejemplo 2026-09-18T03:00:00.000Z`,
      400,
    );
  }

  return fecha;
}

/**
 * Un id opcional de la query string.
 *
 * 400 y no 404, a diferencia de `ubicacionId` en `validarDatosMovimiento`: aca
 * un id de otro comercio no revela nada —el filtro por `comercio_id` hace que
 * simplemente no aparezcan filas—, asi que lo unico que se rechaza es lo que
 * no es un UUID, que de otro modo haria fallar la query con 22P02.
 */
function leerUuidOpcional(valor, nombre) {
  if (valor === undefined || valor === null || valor === "") {
    return undefined;
  }

  if (!esUuid(valor)) {
    throw new ErrorDeNegocio(`El parámetro "${nombre}" no es válido`, 400);
  }

  return valor;
}

function leerEnteroPositivo(valor, porDefecto, nombre) {
  if (valor === undefined || valor === null || valor === "") {
    return porDefecto;
  }

  // Regex y no `Number(...)` solo: la coercion acepta "1e3", " 5 " o "0x10".
  const numero =
    typeof valor === "string" && /^\d+$/.test(valor) ? Number(valor) : NaN;

  if (!Number.isSafeInteger(numero) || numero < 1) {
    throw new ErrorDeNegocio(
      `El parámetro "${nombre}" debe ser un número entero mayor a 0`,
      400,
    );
  }

  return numero;
}

/**
 * Valida y normaliza los filtros del historial (HU-14).
 *
 * Pura, sin base, para testearla sola como `validarDatosMovimiento`. Recibe la
 * query string tal cual y devuelve solo los campos conocidos: un `comercioId`
 * que venga en la URL se pierde aca.
 */
export function validarFiltrosHistorial(query = {}) {
  const desde = leerInstante(query.desde, "desde");
  const hasta = leerInstante(query.hasta, "hasta");

  if (desde && hasta && desde > hasta) {
    throw new ErrorDeNegocio(
      'La fecha "desde" no puede ser posterior a la fecha "hasta"',
      400,
    );
  }

  let tipo;
  if (query.tipo !== undefined && query.tipo !== "") {
    tipo =
      typeof query.tipo === "string" ? query.tipo.trim().toLowerCase() : "";

    if (!TIPOS_DEL_HISTORIAL.includes(tipo)) {
      throw new ErrorDeNegocio(
        `El tipo de movimiento no es válido. Los aceptados son: ${TIPOS_DEL_HISTORIAL.join(", ")}`,
        400,
      );
    }
  }

  const limite = leerEnteroPositivo(
    query.limite,
    LIMITE_HISTORIAL_POR_DEFECTO,
    "limite",
  );

  return {
    desde,
    hasta,
    tipo,
    productoId: leerUuidOpcional(query.productoId, "productoId"),
    proveedorId: leerUuidOpcional(query.proveedorId, "proveedorId"),
    ubicacionId: leerUuidOpcional(query.ubicacionId, "ubicacionId"),
    pagina: leerEnteroPositivo(query.pagina, 1, "pagina"),
    // Se recorta en vez de rechazar, igual que la auditoria: pedir de mas no es
    // un error del usuario, y el tope solo protege a la base.
    limite: Math.min(limite, LIMITE_HISTORIAL_MAXIMO),
  };
}

/**
 * Lista el libro de movimientos del comercio, del mas nuevo al mas viejo, con
 * los filtros de HU-14 combinables entre si.
 *
 * Cada fila trae todos sus datos asociados resueltos (producto, ubicacion y
 * quien lo registro), para que el historial se lea sin otra consulta. No se
 * filtra por `producto.activo`: un producto dado de baja (HU-9) sigue teniendo
 * historia, y ocultarla romperia la auditoria que pide la historia.
 *
 * El proveedor sale como id: la tabla PROVEEDOR llega con HU-19. Cuando exista,
 * se suma el join para devolver tambien el nombre.
 */
export async function listarMovimientos(comercioId, query = {}) {
  const filtros = validarFiltrosHistorial(query);

  const condiciones = [eq(movimiento.comercioId, comercioId)];

  if (filtros.desde) {
    condiciones.push(gte(movimiento.fecha, filtros.desde));
  }
  if (filtros.hasta) {
    condiciones.push(lte(movimiento.fecha, filtros.hasta));
  }
  if (filtros.tipo) {
    condiciones.push(eq(movimiento.tipo, filtros.tipo));
  }
  if (filtros.productoId) {
    condiciones.push(eq(movimiento.productoId, filtros.productoId));
  }
  if (filtros.proveedorId) {
    condiciones.push(eq(movimiento.proveedorId, filtros.proveedorId));
  }
  if (filtros.ubicacionId) {
    condiciones.push(eq(movimiento.ubicacionId, filtros.ubicacionId));
  }

  const donde = and(...condiciones);

  const [filas, [{ total }]] = await Promise.all([
    db
      .select({
        id: movimiento.id,
        fecha: movimiento.fecha,
        tipo: movimiento.tipo,
        cantidad: movimiento.cantidad,
        motivo: movimiento.motivo,
        proveedorId: movimiento.proveedorId,
        transferenciaId: movimiento.transferenciaId,
        productoId: producto.id,
        productoNombre: producto.nombre,
        productoCodigoBarras: producto.codigoBarras,
        productoUnidadMedida: producto.unidadMedida,
        productoActivo: producto.activo,
        ubicacionId: ubicacion.id,
        ubicacionNombre: ubicacion.nombre,
        usuarioId: user.id,
        usuarioNombre: user.name,
        usuarioCorreo: user.email,
      })
      .from(movimiento)
      // inner joins: las tres FK son NOT NULL con `restrict`, asi que toda
      // fila del libro tiene su producto, su ubicacion y su usuario.
      .innerJoin(producto, eq(producto.id, movimiento.productoId))
      .innerJoin(ubicacion, eq(ubicacion.id, movimiento.ubicacionId))
      .innerJoin(user, eq(user.id, movimiento.usuarioId))
      .where(donde)
      // El id desempata movimientos del mismo instante (las dos patas de una
      // transferencia), para que el orden no cambie entre una pagina y otra.
      .orderBy(desc(movimiento.fecha), desc(movimiento.id))
      .limit(filtros.limite)
      .offset((filtros.pagina - 1) * filtros.limite),
    db.select({ total: count() }).from(movimiento).where(donde),
  ]);

  return {
    movimientos: filas.map((fila) => ({
      id: fila.id,
      fecha: fila.fecha,
      tipo: fila.tipo,
      cantidad: fila.cantidad,
      motivo: fila.motivo,
      proveedorId: fila.proveedorId,
      transferenciaId: fila.transferenciaId,
      producto: {
        id: fila.productoId,
        nombre: fila.productoNombre,
        codigoBarras: fila.productoCodigoBarras,
        unidadMedida: fila.productoUnidadMedida,
        activo: fila.productoActivo,
      },
      ubicacion: { id: fila.ubicacionId, nombre: fila.ubicacionNombre },
      usuario: {
        id: fila.usuarioId,
        nombre: fila.usuarioNombre,
        correo: fila.usuarioCorreo,
      },
    })),
    paginacion: {
      pagina: filtros.pagina,
      limite: filtros.limite,
      total,
      totalPaginas: Math.ceil(total / filtros.limite),
    },
  };
}
