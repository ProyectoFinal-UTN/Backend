import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { producto, productoProveedor, proveedor } from "../db/schema.js";
import { ErrorDeNegocio, PG_UNIQUE_VIOLATION, esUuid } from "../lib/errores.js";
import { exigirProductoDelComercio } from "./movimientos.service.js";
import { exigirProveedorDelComercio } from "./proveedores.service.js";

/**
 * Asociacion de productos a proveedores (HU-20).
 *
 * Toda funcion recibe `comercioId` primero y lo saca de la sesion. Las dos
 * puntas del vinculo se validan contra ese comercio antes de escribir: la FK
 * dice que el producto y el proveedor existen, no que sean del mismo dueño.
 *
 * Los vinculos con un producto o un proveedor dado de baja quedan en la tabla
 * (la baja es logica) pero no salen en ninguna consulta: para quien mira la
 * pantalla, ese vinculo ya no existe.
 */

const CAMPOS_PROVEEDOR_ASOCIADO = {
  id: proveedor.id,
  nombre: proveedor.nombre,
  contacto: proveedor.contacto,
  telefono: proveedor.telefono,
  correo: proveedor.correo,
  rubro: proveedor.rubro,
  condicionesPago: proveedor.condicionesPago,
};

const CAMPOS_PRODUCTO_ASOCIADO = {
  id: producto.id,
  nombre: producto.nombre,
  codigoBarras: producto.codigoBarras,
  categoria: producto.categoria,
  unidadMedida: producto.unidadMedida,
};

/** Los ids que no son UUID no existen: 404, no un 500 por el 22P02 de Postgres. */
function exigirUuid(valor, mensaje) {
  if (!esUuid(valor)) {
    throw new ErrorDeNegocio(mensaje, 404);
  }
}

/** Proveedores activos de un producto del comercio, por nombre. */
export async function listarProveedoresDeProducto(comercioId, productoIdCrudo) {
  exigirUuid(productoIdCrudo, "El producto no existe");
  await exigirProductoDelComercio(db, comercioId, productoIdCrudo);

  return db
    .select(CAMPOS_PROVEEDOR_ASOCIADO)
    .from(productoProveedor)
    .innerJoin(proveedor, eq(proveedor.id, productoProveedor.proveedorId))
    .where(
      and(
        eq(productoProveedor.comercioId, comercioId),
        eq(productoProveedor.productoId, productoIdCrudo),
        eq(proveedor.activo, true),
      ),
    )
    .orderBy(asc(proveedor.nombre));
}

/** Productos activos de un proveedor del comercio, por nombre. */
export async function listarProductosDeProveedor(comercioId, proveedorIdCrudo) {
  exigirUuid(proveedorIdCrudo, "El proveedor no existe");
  await exigirProveedorDelComercio(db, comercioId, proveedorIdCrudo);

  return db
    .select(CAMPOS_PRODUCTO_ASOCIADO)
    .from(productoProveedor)
    .innerJoin(producto, eq(producto.id, productoProveedor.productoId))
    .where(
      and(
        eq(productoProveedor.comercioId, comercioId),
        eq(productoProveedor.proveedorId, proveedorIdCrudo),
        eq(producto.activo, true),
      ),
    )
    .orderBy(asc(producto.nombre));
}

/**
 * Asocia un proveedor a un producto.
 *
 * Asociar dos veces lo mismo responde 409 y no 201 silencioso: el criterio de
 * testing de la HU lo pide explicito ("duplicado"), y le avisa a la pantalla
 * que su lista quedo vieja. Lo detecta la PK compuesta, sin SELECT previo.
 *
 * El 404 de cada punta usa el mismo mensaje que el resto del backend ("El
 * producto no existe", "El proveedor no existe"), tambien cuando es de otro
 * comercio: decir "existe pero no es tuyo" filtraria informacion.
 */
export async function asociarProveedor(comercioId, productoIdCrudo, datosCrudos = {}) {
  const proveedorIdCrudo = datosCrudos.proveedorId;

  exigirUuid(productoIdCrudo, "El producto no existe");

  if (proveedorIdCrudo === undefined || proveedorIdCrudo === null || proveedorIdCrudo === "") {
    throw new ErrorDeNegocio("Falta indicar el proveedor a asociar", 400);
  }
  exigirUuid(proveedorIdCrudo, "El proveedor no existe");

  try {
    return await db.transaction(async (tx) => {
      const productoId = await exigirProductoDelComercio(
        tx,
        comercioId,
        productoIdCrudo,
      );
      const proveedorId = await exigirProveedorDelComercio(
        tx,
        comercioId,
        proveedorIdCrudo,
      );

      const [vinculo] = await tx
        .insert(productoProveedor)
        .values({ comercioId, productoId, proveedorId })
        .returning({
          productoId: productoProveedor.productoId,
          proveedorId: productoProveedor.proveedorId,
          createdAt: productoProveedor.createdAt,
        });

      return vinculo;
    });
  } catch (error) {
    const codigo = error?.cause?.code ?? error?.code;

    if (codigo === PG_UNIQUE_VIOLATION) {
      throw new ErrorDeNegocio(
        "Ese proveedor ya está asociado a este producto",
        409,
      );
    }

    throw error;
  }
}

/**
 * Quita el vinculo. Idempotente, como las bajas de productos y proveedores:
 * repetirlo, o pedirlo sobre ids de otro comercio, converge al mismo estado
 * sin error. El filtro por `comercio_id` es el que impide borrar un vinculo
 * ajeno.
 */
export async function desasociarProveedor(comercioId, productoIdCrudo, proveedorIdCrudo) {
  if (!esUuid(productoIdCrudo) || !esUuid(proveedorIdCrudo)) {
    return;
  }

  await db
    .delete(productoProveedor)
    .where(
      and(
        eq(productoProveedor.comercioId, comercioId),
        eq(productoProveedor.productoId, productoIdCrudo),
        eq(productoProveedor.proveedorId, proveedorIdCrudo),
      ),
    );
}

/**
 * Los proveedores activos de varios productos de una sola vez, para sugerir a
 * quien pedirle cuando un producto hay que reponerlo (HU-20, criterio 2).
 *
 * Devuelve un `Map` productoId -> proveedores (por nombre); un producto sin
 * proveedores no tiene entrada. Una sola query para toda la lista, en vez de
 * una por producto. La usan las recomendaciones de reposicion (HU-27) y esta
 * pensada para las alertas de HU-17.
 */
export async function proveedoresDeProductos(comercioId, productoIds) {
  const porProducto = new Map();

  if (productoIds.length === 0) {
    return porProducto;
  }

  const filas = await db
    .select({
      productoId: productoProveedor.productoId,
      id: proveedor.id,
      nombre: proveedor.nombre,
      telefono: proveedor.telefono,
      correo: proveedor.correo,
    })
    .from(productoProveedor)
    .innerJoin(proveedor, eq(proveedor.id, productoProveedor.proveedorId))
    .where(
      and(
        eq(productoProveedor.comercioId, comercioId),
        inArray(productoProveedor.productoId, productoIds),
        eq(proveedor.activo, true),
      ),
    )
    .orderBy(asc(proveedor.nombre));

  for (const { productoId, ...datos } of filas) {
    if (!porProducto.has(productoId)) {
      porProducto.set(productoId, []);
    }
    porProducto.get(productoId).push(datos);
  }

  return porProducto;
}
