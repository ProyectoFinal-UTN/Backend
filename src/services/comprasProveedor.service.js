import { and, count, desc, eq, gte, lte, max, min, sum } from "drizzle-orm";
import { db } from "../db/client.js";
import { movimiento, producto, proveedor, ubicacion } from "../db/schema.js";
import { ErrorDeNegocio, esUuid } from "../lib/errores.js";
import {
  LIMITE_HISTORIAL_MAXIMO,
  LIMITE_HISTORIAL_POR_DEFECTO,
  leerEnteroPositivo,
  leerInstante,
} from "./movimientos.service.js";

/**
 * Historial de compras de un proveedor (HU-21).
 *
 * Se arma leyendo el libro de movimientos: las filas de tipo `compra` que
 * apuntan a ese proveedor. No escribe nada, y no toca la logica de registro de
 * HU-13 — solo la lee.
 *
 * Archivo propio y no dentro de proveedores.service.js, por lo mismo que
 * productoProveedor.service.js: es el otro sub-recurso de proveedor, y
 * mantenerlos separados deja el archivo de HU-19 quieto.
 *
 * El `comercioId` llega primero y sale siempre de la sesion, nunca de la query
 * string.
 *
 * ---------------------------------------------------------------------------
 * LIMITACION CONOCIDA: este historial no tiene montos.
 *
 * El criterio de aceptacion de la HU pide "fechas, productos y montos", pero el
 * modelo no tiene de donde sacarlos: `movimiento` (HU-13) guarda fecha,
 * usuario, producto, cantidad, tipo y proveedor, sin precio ni costo, y no hay
 * ningun campo monetario en `producto`, `proveedor` ni `producto_proveedor`
 * (lo unico es `comercio.moneda`, que es configuracion). Agregar un precio
 * cambiaria el contrato de HU-13, que ya esta mergeada, asi que queda fuera del
 * alcance de esta HU. `resumen.montos` se devuelve explicitamente en `null`
 * para que el Frontend lo sepa en vez de adivinarlo, y el resumen informa el
 * volumen (compras, unidades, primera y ultima) que el modelo si sostiene.
 * ---------------------------------------------------------------------------
 */

/**
 * El tipo es fijo y no un parametro.
 *
 * El criterio de aceptacion dice "movimientos de tipo compra" y el enum tiene
 * ese valor exacto (ver `tipoMovimiento` en db/schema.js). La subtarea de Jira
 * dice "movimientos de entrada", que no es lo mismo: entrada seria
 * `cantidad > 0`, que mete los ajustes positivos —el alta de un producto con
 * stock inicial (HU-9) genera uno— y la pata de destino de una transferencia
 * (HU-12). Ninguna de las dos es una compra a un proveedor.
 */
const TIPO_COMPRA = "compra";

/** Las mismas columnas que el historial de HU-14, menos las que no aplican. */
const CAMPOS_COMPRA = {
  id: movimiento.id,
  fecha: movimiento.fecha,
  cantidad: movimiento.cantidad,
  motivo: movimiento.motivo,
  productoId: producto.id,
  productoNombre: producto.nombre,
  productoCodigoBarras: producto.codigoBarras,
  productoUnidadMedida: producto.unidadMedida,
  productoActivo: producto.activo,
  ubicacionId: ubicacion.id,
  ubicacionNombre: ubicacion.nombre,
};

/**
 * Valida y normaliza el periodo y la paginacion.
 *
 * Pura, sin base, para testearla sola como `validarFiltrosHistorial`. Devuelve
 * solo los campos conocidos: un `comercioId`, un `tipo` o un `proveedorId` que
 * vengan en la query se pierden aca.
 *
 * No reusa `validarFiltrosHistorial` entera porque esa valida filtros que este
 * endpoint no expone (`tipo`, `productoId`, `ubicacionId`): aceptarlos y
 * despues ignorarlos seria peor que no aceptarlos. Si reusa sus lectores, que
 * son los que tienen las reglas finas (zona obligatoria en las fechas, rechazo
 * de "1e3" en los enteros).
 */
export function validarFiltrosCompras(query = {}) {
  const desde = leerInstante(query.desde, "desde");
  const hasta = leerInstante(query.hasta, "hasta");

  if (desde && hasta && desde > hasta) {
    throw new ErrorDeNegocio(
      'La fecha "desde" no puede ser posterior a la fecha "hasta"',
      400,
    );
  }

  const limite = leerEnteroPositivo(
    query.limite,
    LIMITE_HISTORIAL_POR_DEFECTO,
    "limite",
  );

  return {
    desde,
    hasta,
    pagina: leerEnteroPositivo(query.pagina, 1, "pagina"),
    // Se recorta en vez de rechazar, igual que HU-14: pedir de mas no es un
    // error del usuario, y el tope solo protege a la base.
    limite: Math.min(limite, LIMITE_HISTORIAL_MAXIMO),
  };
}

/**
 * El proveedor del historial, sin filtrar por `activo`.
 *
 * A diferencia de `obtenerProveedor` y `exigirProveedorDelComercio` (HU-19),
 * que solo miran los activos: un proveedor dado de baja tiene que seguir
 * mostrando a quien se le compro —lo dice el comentario de `proveedor` en
 * db/schema.js y lo hace ya el filtro `proveedorId` del historial de HU-14—, y
 * esconderle su historia al gerente seria perder justo lo que la HU pide
 * evaluar. Devuelve `activo` para que la pantalla lo pueda etiquetar.
 *
 * 404 y no 403 cuando es de otro comercio, con el mismo mensaje que cuando no
 * existe: decir "existe pero no es tuyo" filtraria informacion de otro
 * comercio. Un id que no es UUID tambien es 404 y no un 500 por el 22P02 de
 * Postgres.
 */
async function exigirProveedorDelHistorial(comercioId, proveedorIdCrudo) {
  if (!esUuid(proveedorIdCrudo)) {
    throw new ErrorDeNegocio("El proveedor no existe", 404);
  }

  const [fila] = await db
    .select({
      id: proveedor.id,
      nombre: proveedor.nombre,
      activo: proveedor.activo,
    })
    .from(proveedor)
    .where(
      and(
        eq(proveedor.id, proveedorIdCrudo),
        eq(proveedor.comercioId, comercioId),
      ),
    )
    .limit(1);

  if (!fila) {
    throw new ErrorDeNegocio("El proveedor no existe", 404);
  }

  return fila;
}

/**
 * Un entero que llega de un agregado de Postgres.
 *
 * `SUM(integer)` devuelve `bigint`, que el driver entrega como string, y sobre
 * cero filas devuelve `NULL`. Para las unidades compradas, `null` es 0 —no se
 * compro nada—, asi que la coercion va bien; lo que no se puede hacer es
 * aplicarsela a un `MIN`/`MAX` de fecha, donde `null` tiene que quedar `null`
 * (ver abajo). Si el total no entra en un entero seguro se corta: preferible a
 * devolver un numero que miente por redondeo.
 */
function enteroDeAgregado(valor) {
  const numero = Number(valor ?? 0);

  if (!Number.isSafeInteger(numero)) {
    throw new ErrorDeNegocio(
      "El total de unidades compradas es demasiado grande para informarlo",
      500,
    );
  }

  return numero;
}

/**
 * Las compras hechas a un proveedor, de la mas nueva a la mas vieja, con
 * filtro por periodo y paginacion.
 *
 * El `resumen` se calcula sobre TODO el periodo filtrado y no sobre la pagina:
 * un total que cambia al pasar de pagina no es un total. Sale de la misma
 * query que el conteo de la paginacion, que ya tenia que correr igual.
 *
 * No devuelve quien registro cada compra: el criterio pide fechas, productos y
 * montos, y sin el campo `usuario` no hay que reimplementar el recorte de
 * correos por rol de HU-32 (un empleado no ve los correos del equipo). Quien
 * necesite ese dato tiene el historial completo de HU-14.
 *
 * Sin transaccion: son dos lecturas sobre una tabla append-only, y envolverlas
 * daria la ilusion de un invariante que no hace falta sostener.
 */
export async function historialDeCompras(
  comercioId,
  proveedorIdCrudo,
  query = {},
) {
  const filtros = validarFiltrosCompras(query);
  const datosProveedor = await exigirProveedorDelHistorial(
    comercioId,
    proveedorIdCrudo,
  );

  const condiciones = [
    eq(movimiento.comercioId, comercioId),
    eq(movimiento.proveedorId, datosProveedor.id),
    eq(movimiento.tipo, TIPO_COMPRA),
  ];

  if (filtros.desde) {
    condiciones.push(gte(movimiento.fecha, filtros.desde));
  }
  if (filtros.hasta) {
    condiciones.push(lte(movimiento.fecha, filtros.hasta));
  }

  // Las compras sin proveedor (`proveedor_id` es nullable: HU-13 no lo exige ni
  // en las compras) quedan afuera solas, porque NULL no iguala a ningun id.

  const donde = and(...condiciones);

  const [filas, [agregado]] = await Promise.all([
    db
      .select(CAMPOS_COMPRA)
      .from(movimiento)
      // inner joins: las dos FK son NOT NULL con `restrict`, asi que toda fila
      // del libro tiene su producto y su ubicacion. Sin filtrar por
      // `producto.activo`, igual que HU-14: a un producto dado de baja se le
      // compro igual, y esconderlo falsearia el historial.
      .innerJoin(producto, eq(producto.id, movimiento.productoId))
      .innerJoin(ubicacion, eq(ubicacion.id, movimiento.ubicacionId))
      .where(donde)
      // El id desempata compras del mismo instante, para que el orden no cambie
      // entre una pagina y otra y ninguna fila se repita o se saltee.
      .orderBy(desc(movimiento.fecha), desc(movimiento.id))
      .limit(filtros.limite)
      .offset((filtros.pagina - 1) * filtros.limite),
    db
      .select({
        total: count(),
        unidades: sum(movimiento.cantidad),
        primeraCompra: min(movimiento.fecha),
        ultimaCompra: max(movimiento.fecha),
      })
      .from(movimiento)
      .where(donde),
  ]);

  const total = agregado.total;

  return {
    proveedor: datosProveedor,
    compras: filas.map((fila) => ({
      id: fila.id,
      fecha: fila.fecha,
      cantidad: fila.cantidad,
      motivo: fila.motivo,
      producto: {
        id: fila.productoId,
        nombre: fila.productoNombre,
        codigoBarras: fila.productoCodigoBarras,
        unidadMedida: fila.productoUnidadMedida,
        activo: fila.productoActivo,
      },
      ubicacion: { id: fila.ubicacionId, nombre: fila.ubicacionNombre },
    })),
    resumen: {
      compras: total,
      unidades: enteroDeAgregado(agregado.unidades),
      // Campo por campo y no con una conversion generica: sin compras en el
      // periodo, estas dos son `null` y tienen que seguir siendo `null`. Un
      // `new Date(null)` las volveria 1970 y un `Number(null)`, 0.
      primeraCompra: agregado.primeraCompra ?? null,
      ultimaCompra: agregado.ultimaCompra ?? null,
      // No hay montos en el modelo (ver el comentario de arriba). Explicito y
      // no omitido: le dice al Frontend que el dato no existe todavia.
      montos: null,
    },
    paginacion: {
      pagina: filtros.pagina,
      limite: filtros.limite,
      total,
      totalPaginas: Math.ceil(total / filtros.limite),
    },
  };
}
