import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { producto, stock, ubicacion } from "../db/schema.js";
import { ErrorDeNegocio, PG_UNIQUE_VIOLATION, esUuid } from "../lib/errores.js";
import { buscarEnOpenFoodFacts } from "./productosExternos.service.js";

/**
 * Logica de negocio del catalogo de productos (HU-9).
 *
 * Toda funcion recibe `comercioId` primero y lo usa en el WHERE/INSERT. Ese
 * valor sale siempre de la sesion (lo pone `requireAuth`), nunca del body ni
 * de la query string.
 */

const NOMBRE_UBICACION_POR_DEFECTO = "Principal";
const FORMATO_CODIGO_BARRAS = /^\d{6,64}$/;
const UNIDADES_VALIDAS = [
  "unidad",
  "kg",
  "g",
  "l",
  "ml",
  "caja",
  "paquete",
  "docena",
];

/**
 * Maximo de un `integer` de Postgres, que es el tipo de `producto.umbral_minimo`
 * y de `stock.cantidad`. Sin este tope, un valor mas grande pasa la validacion
 * y recien falla en el INSERT con 22003, que sale como 500 en vez del 400 que
 * corresponde a un dato invalido. Mismo hueco ya cerrado en HU-13
 * (movimientos.service.js, CANTIDAD_MAXIMA).
 */
const MAXIMO_ENTERO_POSTGRES = 2147483647;

const CAMPOS_PRODUCTO = {
  id: producto.id,
  nombre: producto.nombre,
  codigoBarras: producto.codigoBarras,
  categoria: producto.categoria,
  unidadMedida: producto.unidadMedida,
  umbralMinimo: producto.umbralMinimo,
  createdAt: producto.createdAt,
  updatedAt: producto.updatedAt,
};

/**
 * Exige un `number` de JS real (no coerciona strings/null/arrays), entero,
 * no negativo, y dentro del rango de un `integer` de Postgres.
 *
 * No se usa `Number(valor)` antes de este chequeo a proposito:
 * `Number(null)`, `Number("")` y `Number([])` dan `0`, asi que un
 * `{"stockActual": null}` explicito colaria como stock 0 en silencio en vez
 * de rechazarse como dato invalido.
 */
function esEnteroNoNegativo(valor) {
  return (
    typeof valor === "number" &&
    Number.isInteger(valor) &&
    valor >= 0 &&
    valor <= MAXIMO_ENTERO_POSTGRES
  );
}

/**
 * Valida y normaliza los datos de un producto.
 *
 * `parcial` se usa en la edicion: solo valida los campos presentes en el
 * patch (para que un PUT pueda mandar un subconjunto de campos) e ignora
 * `stockActual`, que no se acepta fuera del alta — cambiar cantidades es
 * responsabilidad de MOVIMIENTO+STOCK (HU-13), no de editar el producto.
 */
export function validarDatosProducto(datosCrudos = {}, { parcial = false } = {}) {
  const datos = {};
  const tiene = (campo) =>
    !parcial || Object.prototype.hasOwnProperty.call(datosCrudos, campo);

  if (tiene("nombre")) {
    const nombre =
      typeof datosCrudos.nombre === "string" ? datosCrudos.nombre.trim() : "";
    if (!nombre || nombre.length > 150) {
      throw new ErrorDeNegocio(
        "El nombre del producto es obligatorio y debe tener hasta 150 caracteres",
        400,
      );
    }
    datos.nombre = nombre;
  }

  if (tiene("codigoBarras")) {
    const codigoBarras =
      typeof datosCrudos.codigoBarras === "string"
        ? datosCrudos.codigoBarras.trim()
        : "";
    if (!FORMATO_CODIGO_BARRAS.test(codigoBarras)) {
      throw new ErrorDeNegocio("El código de barras es inválido", 400);
    }
    datos.codigoBarras = codigoBarras;
  }

  if (tiene("categoria")) {
    const categoria =
      typeof datosCrudos.categoria === "string"
        ? datosCrudos.categoria.trim()
        : "";
    if (!categoria || categoria.length > 100) {
      throw new ErrorDeNegocio(
        "La categoría es obligatoria y debe tener hasta 100 caracteres",
        400,
      );
    }
    datos.categoria = categoria;
  }

  if (tiene("unidadMedida")) {
    const unidadMedida =
      typeof datosCrudos.unidadMedida === "string"
        ? datosCrudos.unidadMedida.trim().toLowerCase()
        : "";
    if (!UNIDADES_VALIDAS.includes(unidadMedida)) {
      throw new ErrorDeNegocio(
        `La unidad de medida no es válida. Las aceptadas son: ${UNIDADES_VALIDAS.join(", ")}`,
        400,
      );
    }
    datos.unidadMedida = unidadMedida;
  }

  if (tiene("umbralMinimo")) {
    const umbralMinimo = datosCrudos.umbralMinimo;
    if (!esEnteroNoNegativo(umbralMinimo)) {
      throw new ErrorDeNegocio(
        "El umbral mínimo debe ser un número entero entre 0 y 2147483647",
        400,
      );
    }
    datos.umbralMinimo = umbralMinimo;
  }

  if (!parcial) {
    const stockActual = datosCrudos.stockActual;
    if (!esEnteroNoNegativo(stockActual)) {
      throw new ErrorDeNegocio(
        "El stock actual debe ser un número entero entre 0 y 2147483647",
        400,
      );
    }
    datos.stockActual = stockActual;
  }

  return datos;
}

/**
 * Convierte el choque contra `producto_comercio_codigoBarras_uidx` en el 409
 * que corresponde. No hay chequeo previo con SELECT: la ventana entre el
 * SELECT y el INSERT/UPDATE permitiria que dos altas simultaneas la
 * atravesaran (ver el mismo problema resuelto en ubicaciones.service.js).
 *
 * Chequea el nombre del constraint (no solo el codigo 23505) porque la misma
 * transaccion de alta puede violar OTRO unique (el de `ubicacion`, al crear
 * la "Principal" por defecto) — ver `resolverUbicacionParaAlta`, que evita esa
 * colision con `onConflictDoNothing` en vez de dejarla llegar hasta aca. Este
 * chequeo por nombre queda como defensa en profundidad.
 */
function traducirCodigoBarrasDuplicado(error, codigoBarras) {
  const constraint = error?.cause?.constraint ?? error?.constraint;
  const esViolacionDeCodigoBarras =
    (error?.cause?.code === PG_UNIQUE_VIOLATION ||
      error?.code === PG_UNIQUE_VIOLATION) &&
    constraint === "producto_comercio_codigoBarras_uidx";

  if (esViolacionDeCodigoBarras) {
    return new ErrorDeNegocio(
      `Ya existe un producto con el código de barras "${codigoBarras}"`,
      409,
    );
  }

  return error;
}

/**
 * Resuelve la ubicacion inicial del stock, dentro de la misma transaccion
 * que crea el producto.
 *
 * Si el cliente indico una `ubicacionId`, se valida que exista y sea del
 * comercio. Si no indico ninguna, se usa la primera ubicacion del comercio
 * o, si todavia no tiene ninguna, se crea una "Principal": los criterios de
 * aceptacion de HU-9 no piden elegir ubicacion en el formulario, y exigir que
 * exista una de antemano acoplaria el alta de productos a que el usuario ya
 * haya pasado por la pantalla de ubicaciones (HU-8), cosa que ninguna de las
 * dos historias pide.
 */
async function resolverUbicacionParaAlta(tx, comercioId, ubicacionIdCrudo) {
  if (ubicacionIdCrudo !== undefined && ubicacionIdCrudo !== null) {
    if (!esUuid(ubicacionIdCrudo)) {
      throw new ErrorDeNegocio("La ubicación indicada no existe", 400);
    }

    const [existente] = await tx
      .select({ id: ubicacion.id })
      .from(ubicacion)
      .where(
        and(
          eq(ubicacion.id, ubicacionIdCrudo),
          eq(ubicacion.comercioId, comercioId),
        ),
      )
      .limit(1);

    if (!existente) {
      throw new ErrorDeNegocio("La ubicación indicada no existe", 400);
    }

    return existente.id;
  }

  // `orderBy` es necesario: sin el, un `LIMIT 1` no tiene ninguna garantia de
  // que devuelva siempre la misma fila entre corridas (Postgres no promete un
  // orden fisico), asi que altas sucesivas sin `ubicacionId` podrian caer en
  // ubicaciones distintas si el comercio tiene mas de una.
  const [primera] = await tx
    .select({ id: ubicacion.id })
    .from(ubicacion)
    .where(eq(ubicacion.comercioId, comercioId))
    .orderBy(asc(ubicacion.createdAt))
    .limit(1);

  if (primera) {
    return primera.id;
  }

  // `onConflictDoNothing` en vez de un try/catch: si dos altas concurrentes
  // llegan hasta aca a la vez, un error de constraint dejaria la transaccion
  // abortada (Postgres no permite mas queries en la misma tx despues de un
  // error sin un SAVEPOINT), asi que un catch-y-reintento no funcionaria. Sin
  // conflicto, el insert resuelve normal.
  const [creada] = await tx
    .insert(ubicacion)
    .values({ comercioId, nombre: NOMBRE_UBICACION_POR_DEFECTO })
    .onConflictDoNothing({ target: [ubicacion.comercioId, ubicacion.nombre] })
    .returning({ id: ubicacion.id });

  if (creada) {
    return creada.id;
  }

  // Otra alta concurrente ya creo "Principal" un instante antes: se reusa.
  const [existente] = await tx
    .select({ id: ubicacion.id })
    .from(ubicacion)
    .where(
      and(
        eq(ubicacion.comercioId, comercioId),
        eq(ubicacion.nombre, NOMBRE_UBICACION_POR_DEFECTO),
      ),
    )
    .limit(1);

  // Solo alcanzable si esa fila se borro justo entre el onConflictDoNothing y
  // este SELECT (por ejemplo, via DELETE /api/ubicaciones/:id de HU-8). Sin
  // este chequeo, `existente.id` tiraria un TypeError sin status que llegaria
  // al cliente como un 500 sin contexto.
  if (!existente) {
    throw new ErrorDeNegocio(
      "No se pudo resolver la ubicación por defecto",
      500,
    );
  }

  return existente.id;
}

export async function listarProductos(comercioId) {
  return db
    .select(CAMPOS_PRODUCTO)
    .from(producto)
    .where(
      and(eq(producto.comercioId, comercioId), eq(producto.activo, true)),
    )
    .orderBy(asc(producto.nombre));
}

export async function obtenerProducto(comercioId, idCrudo) {
  if (!esUuid(idCrudo)) {
    throw new ErrorDeNegocio("El producto no existe", 404);
  }

  const [fila] = await db
    .select(CAMPOS_PRODUCTO)
    .from(producto)
    .where(
      and(
        eq(producto.id, idCrudo),
        eq(producto.comercioId, comercioId),
        eq(producto.activo, true),
      ),
    )
    .limit(1);

  if (!fila) {
    throw new ErrorDeNegocio("El producto no existe", 404);
  }

  return fila;
}

export async function crearProducto(comercioId, datosCrudos = {}) {
  const datos = validarDatosProducto(datosCrudos);

  try {
    return await db.transaction(async (tx) => {
      const [nuevoProducto] = await tx
        .insert(producto)
        .values({
          comercioId,
          nombre: datos.nombre,
          codigoBarras: datos.codigoBarras,
          categoria: datos.categoria,
          unidadMedida: datos.unidadMedida,
          umbralMinimo: datos.umbralMinimo,
        })
        .returning(CAMPOS_PRODUCTO);

      const ubicacionId = await resolverUbicacionParaAlta(
        tx,
        comercioId,
        datosCrudos.ubicacionId,
      );

      const [nuevoStock] = await tx
        .insert(stock)
        .values({
          comercioId,
          productoId: nuevoProducto.id,
          ubicacionId,
          cantidad: datos.stockActual,
        })
        .returning({
          id: stock.id,
          ubicacionId: stock.ubicacionId,
          cantidad: stock.cantidad,
        });

      return { ...nuevoProducto, stock: nuevoStock };
    });
  } catch (error) {
    throw traducirCodigoBarrasDuplicado(error, datos.codigoBarras);
  }
}

export async function actualizarProducto(comercioId, idCrudo, datosCrudos = {}) {
  if (!esUuid(idCrudo)) {
    throw new ErrorDeNegocio("El producto no existe", 404);
  }

  const datos = validarDatosProducto(datosCrudos, { parcial: true });

  if (Object.keys(datos).length === 0) {
    throw new ErrorDeNegocio("No se enviaron campos para actualizar", 400);
  }

  try {
    const [actualizado] = await db
      .update(producto)
      .set(datos)
      .where(
        and(
          eq(producto.id, idCrudo),
          eq(producto.comercioId, comercioId),
          eq(producto.activo, true),
        ),
      )
      .returning(CAMPOS_PRODUCTO);

    if (!actualizado) {
      throw new ErrorDeNegocio("El producto no existe", 404);
    }

    return actualizado;
  } catch (error) {
    throw traducirCodigoBarrasDuplicado(error, datos.codigoBarras);
  }
}

/**
 * Elimina (logicamente) un producto.
 *
 * A diferencia de `eliminarUbicacion`, esto nunca lanza 404: el DELETE tiene
 * que ser idempotente (repetirlo, o llamarlo sobre un id que no es de este
 * comercio o que ya esta inactivo, siempre converge al mismo estado sin
 * error), tal como pide el criterio de "eliminar con confirmacion previa" de
 * HU-9 sin necesitar que el cliente maneje un caso especial.
 */
export async function eliminarProducto(comercioId, idCrudo) {
  if (!esUuid(idCrudo)) {
    return;
  }

  await db
    .update(producto)
    .set({ activo: false })
    .where(
      and(eq(producto.id, idCrudo), eq(producto.comercioId, comercioId)),
    );
}

/**
 * Consulta previa al alta (enhancement opcional, ver plan §10): si el codigo
 * ya existe en el catalogo del comercio, lo devuelve para que el Frontend
 * pueda ofrecer editarlo en vez de duplicarlo. Si no existe, intenta traer
 * una sugerencia de Open Food Facts — nunca falla por eso, `sugerencia`
 * simplemente puede venir en null.
 */
export async function verificarCodigo(comercioId, codigoBarrasCrudo) {
  const codigoBarras =
    typeof codigoBarrasCrudo === "string" ? codigoBarrasCrudo.trim() : "";

  if (!FORMATO_CODIGO_BARRAS.test(codigoBarras)) {
    throw new ErrorDeNegocio("El código de barras es inválido", 400);
  }

  const [existente] = await db
    .select(CAMPOS_PRODUCTO)
    .from(producto)
    .where(
      and(
        eq(producto.comercioId, comercioId),
        eq(producto.codigoBarras, codigoBarras),
        eq(producto.activo, true),
      ),
    )
    .limit(1);

  if (existente) {
    return { existe: true, producto: existente };
  }

  const sugerencia = await buscarEnOpenFoodFacts(codigoBarras);
  return { existe: false, sugerencia };
}