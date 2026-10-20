import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { proveedor } from "../db/schema.js";
import { ErrorDeNegocio, PG_UNIQUE_VIOLATION, esUuid } from "../lib/errores.js";

/**
 * Logica de negocio del directorio de proveedores (HU-19).
 *
 * Toda funcion recibe `comercioId` primero y lo usa en el WHERE/INSERT. Ese
 * valor sale siempre de la sesion (lo pone `requireAuth`), nunca del body ni
 * de la query string.
 */

/**
 * Formato minimo de correo: algo, una arroba, algo, un punto, algo. No busca
 * validar el RFC entero, solo atajar lo que claramente no es un correo
 * ("juan", "juan@") antes de guardarlo.
 */
const FORMATO_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Campos opcionales con su tope, que es el largo de la columna. El tope tiene
 * que estar aca y no solo en la base: un texto mas largo falla en el INSERT con
 * 22001, que sale como 500 en vez del 400 que corresponde.
 */
const CAMPOS_OPCIONALES = {
  contacto: { maximo: 150, etiqueta: "El contacto" },
  telefono: { maximo: 40, etiqueta: "El teléfono" },
  correo: { maximo: 255, etiqueta: "El correo" },
  rubro: { maximo: 100, etiqueta: "El rubro" },
  condicionesPago: { maximo: 255, etiqueta: "Las condiciones de pago" },
};

const CAMPOS_PROVEEDOR = {
  id: proveedor.id,
  nombre: proveedor.nombre,
  contacto: proveedor.contacto,
  telefono: proveedor.telefono,
  correo: proveedor.correo,
  rubro: proveedor.rubro,
  condicionesPago: proveedor.condicionesPago,
  createdAt: proveedor.createdAt,
  updatedAt: proveedor.updatedAt,
};

/**
 * Valida y normaliza los datos de un proveedor.
 *
 * Solo el nombre es obligatorio: un comercio chico muchas veces conoce al
 * proveedor por el nombre y nada mas, y exigir el resto en el alta lo empujaria
 * a no cargarlo. Los opcionales vacios se guardan como `null` y no como "", por
 * lo mismo que el motivo de un movimiento: una cadena vacia seria un dato que
 * existe y no dice nada. Mandar `null` o "" en la edicion borra el dato.
 *
 * `parcial` se usa en la edicion: solo valida los campos presentes en el patch.
 */
export function validarDatosProveedor(datosCrudos = {}, { parcial = false } = {}) {
  const datos = {};
  const tiene = (campo) =>
    !parcial || Object.prototype.hasOwnProperty.call(datosCrudos, campo);

  if (tiene("nombre")) {
    const nombre =
      typeof datosCrudos.nombre === "string" ? datosCrudos.nombre.trim() : "";
    if (!nombre || nombre.length > 150) {
      throw new ErrorDeNegocio(
        "El nombre del proveedor es obligatorio y debe tener hasta 150 caracteres",
        400,
      );
    }
    datos.nombre = nombre;
  }

  for (const [campo, { maximo, etiqueta }] of Object.entries(CAMPOS_OPCIONALES)) {
    if (!tiene(campo)) {
      continue;
    }

    const crudo = datosCrudos[campo];

    if (crudo === undefined || crudo === null) {
      datos[campo] = null;
      continue;
    }

    // Un numero o un objeto no se convierten a texto en silencio: un
    // `{"telefono": 1155550000}` es un error del cliente, y aceptarlo
    // ocultaria el bug en vez de mostrarlo.
    if (typeof crudo !== "string") {
      throw new ErrorDeNegocio(`${etiqueta} debe ser un texto`, 400);
    }

    const valor = crudo.trim();

    if (valor.length > maximo) {
      throw new ErrorDeNegocio(
        `${etiqueta} no puede superar los ${maximo} caracteres`,
        400,
      );
    }

    datos[campo] = valor === "" ? null : valor;
  }

  if (datos.correo && !FORMATO_CORREO.test(datos.correo)) {
    throw new ErrorDeNegocio("El correo del proveedor no es válido", 400);
  }

  return datos;
}

/**
 * Convierte el choque contra `proveedor_comercio_nombre_uidx` en el 409 que
 * corresponde. Sin SELECT previo, por lo mismo que en productos.service.js: la
 * ventana entre el SELECT y el INSERT dejaria pasar dos altas simultaneas.
 */
function traducirNombreDuplicado(error, nombre) {
  const constraint = error?.cause?.constraint ?? error?.constraint;
  const esViolacionDeNombre =
    (error?.cause?.code === PG_UNIQUE_VIOLATION ||
      error?.code === PG_UNIQUE_VIOLATION) &&
    constraint === "proveedor_comercio_nombre_uidx";

  if (esViolacionDeNombre) {
    return new ErrorDeNegocio(`Ya existe un proveedor llamado "${nombre}"`, 409);
  }

  return error;
}

export async function listarProveedores(comercioId) {
  return db
    .select(CAMPOS_PROVEEDOR)
    .from(proveedor)
    .where(
      and(eq(proveedor.comercioId, comercioId), eq(proveedor.activo, true)),
    )
    .orderBy(asc(proveedor.nombre));
}

export async function obtenerProveedor(comercioId, idCrudo) {
  if (!esUuid(idCrudo)) {
    throw new ErrorDeNegocio("El proveedor no existe", 404);
  }

  const [fila] = await db
    .select(CAMPOS_PROVEEDOR)
    .from(proveedor)
    .where(
      and(
        eq(proveedor.id, idCrudo),
        eq(proveedor.comercioId, comercioId),
        eq(proveedor.activo, true),
      ),
    )
    .limit(1);

  if (!fila) {
    throw new ErrorDeNegocio("El proveedor no existe", 404);
  }

  return fila;
}

export async function crearProveedor(comercioId, datosCrudos = {}) {
  const datos = validarDatosProveedor(datosCrudos);

  try {
    const [creado] = await db
      .insert(proveedor)
      .values({ comercioId, ...datos })
      .returning(CAMPOS_PROVEEDOR);

    return creado;
  } catch (error) {
    throw traducirNombreDuplicado(error, datos.nombre);
  }
}

export async function actualizarProveedor(comercioId, idCrudo, datosCrudos = {}) {
  if (!esUuid(idCrudo)) {
    throw new ErrorDeNegocio("El proveedor no existe", 404);
  }

  const datos = validarDatosProveedor(datosCrudos, { parcial: true });

  if (Object.keys(datos).length === 0) {
    throw new ErrorDeNegocio("No se enviaron campos para actualizar", 400);
  }

  try {
    const [actualizado] = await db
      .update(proveedor)
      .set(datos)
      .where(
        and(
          eq(proveedor.id, idCrudo),
          eq(proveedor.comercioId, comercioId),
          eq(proveedor.activo, true),
        ),
      )
      .returning(CAMPOS_PROVEEDOR);

    if (!actualizado) {
      throw new ErrorDeNegocio("El proveedor no existe", 404);
    }

    return actualizado;
  } catch (error) {
    throw traducirNombreDuplicado(error, datos.nombre);
  }
}

/**
 * Elimina (logicamente) un proveedor.
 *
 * Baja logica y no DELETE: los movimientos de compra lo referencian y el libro
 * es append-only, asi que el historial tiene que poder seguir diciendo a quien
 * se le compro. Idempotente, igual que `eliminarProducto`: repetirlo, o
 * llamarlo sobre un id que no es de este comercio, converge al mismo estado
 * sin error.
 */
export async function eliminarProveedor(comercioId, idCrudo) {
  if (!esUuid(idCrudo)) {
    return;
  }

  await db
    .update(proveedor)
    .set({ activo: false })
    .where(
      and(eq(proveedor.id, idCrudo), eq(proveedor.comercioId, comercioId)),
    );
}

/**
 * Verifica que el proveedor exista, sea de este comercio y no este dado de
 * baja. La usa el registro de movimientos: sin esto, una compra podia quedar
 * apuntando al proveedor de OTRO comercio con solo conocer su id.
 *
 * 404 y no 403 por el mismo criterio que productos y ubicaciones: decir
 * "existe pero no es tuyo" filtraria informacion de otro comercio.
 */
export async function exigirProveedorDelComercio(tx, comercioId, proveedorId) {
  const [fila] = await tx
    .select({ id: proveedor.id })
    .from(proveedor)
    .where(
      and(
        eq(proveedor.id, proveedorId),
        eq(proveedor.comercioId, comercioId),
        eq(proveedor.activo, true),
      ),
    )
    .limit(1);

  if (!fila) {
    throw new ErrorDeNegocio("El proveedor no existe", 404);
  }

  return fila.id;
}
