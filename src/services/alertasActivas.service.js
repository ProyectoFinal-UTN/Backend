import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { alerta, producto, stock, ubicacion } from "../db/schema.js";
import {
  LIMITE_HISTORIAL_MAXIMO,
  LIMITE_HISTORIAL_POR_DEFECTO,
  leerEnteroPositivo,
} from "./movimientos.service.js";
import { proveedoresDeProductos } from "./productoProveedor.service.js";

/**
 * Listado de alertas activas para el panel principal (HU-17, SCRUM-128).
 *
 * Solo lee. Quien abre y cierra las alertas es `evaluarAlertaDeStock`
 * (alertas.service.js), dentro de la transaccion que mueve el stock.
 *
 * Archivo aparte de alertas.service.js y no una funcion mas ahi, por una razon
 * concreta: `movimientos.service.js` importa el evaluador, asi que si el
 * evaluador viviera en el mismo modulo que este listado —que necesita los
 * lectores de paginacion de `movimientos.service.js`— los dos modulos se
 * importarian entre si. Es la misma separacion por sub-recurso que ya hay
 * entre proveedores.service.js, productoProveedor.service.js y
 * comprasProveedor.service.js.
 *
 * El `comercioId` llega primero y sale siempre de la sesion, nunca de la query
 * string.
 */

/** Saldo del producto en todo el comercio, sumando ubicaciones. */
const TOTAL_EN_STOCK = sql`coalesce(sum(${stock.cantidad}), 0)`;

/**
 * Valida y normaliza la paginacion.
 *
 * Pura, sin base, para testearla sola como `validarFiltrosCompras` (HU-21).
 * Devuelve solo los campos conocidos: un `comercioId` o un `estado` que vengan
 * en la query se pierden aca.
 *
 * No hay filtro por `estado`: el alcance de la subtarea es "listar alertas
 * activas". Las resueltas quedan en la tabla, pero todavia no se exponen, y
 * aceptar un parametro para despues ignorarlo seria peor que no aceptarlo.
 *
 * Reusa los lectores de HU-14, que son los que tienen las reglas finas (el
 * rechazo de "1e3" y de los decimales), para que los mensajes de error sean
 * los mismos en toda la API.
 */
export function validarFiltrosAlertas(query = {}) {
  const limite = leerEnteroPositivo(
    query.limite,
    LIMITE_HISTORIAL_POR_DEFECTO,
    "limite",
  );

  return {
    pagina: leerEnteroPositivo(query.pagina, 1, "pagina"),
    // Se recorta en vez de rechazar, igual que HU-14 y HU-21: pedir de mas no
    // es un error del usuario, y el tope solo protege a la base.
    limite: Math.min(limite, LIMITE_HISTORIAL_MAXIMO),
  };
}

/**
 * En que ubicaciones hay mercaderia de cada producto, de una sola vez.
 *
 * Devuelve un `Map` productoId -> ubicaciones; un producto sin existencias en
 * ningun lado no tiene entrada. Es el desglose que pide la subtarea de
 * Frontend (SCRUM-129): el umbral es por producto y se compara contra el total
 * del comercio, asi que la alerta no tiene UNA ubicacion, pero si tiene el
 * reparto de lo que queda.
 *
 * Las filas en cero quedan afuera: una ubicacion donde no hay nada no ayuda a
 * ir a buscar la mercaderia, y toda ubicacion que alguna vez tuvo stock
 * conserva su fila en `stock` con cantidad 0.
 */
async function ubicacionesDeProductos(comercioId, productoIds) {
  const porProducto = new Map();

  if (productoIds.length === 0) {
    return porProducto;
  }

  const filas = await db
    .select({
      productoId: stock.productoId,
      id: ubicacion.id,
      nombre: ubicacion.nombre,
      cantidad: stock.cantidad,
    })
    .from(stock)
    .innerJoin(ubicacion, eq(ubicacion.id, stock.ubicacionId))
    .where(
      and(
        eq(stock.comercioId, comercioId),
        inArray(stock.productoId, productoIds),
        sql`${stock.cantidad} <> 0`,
      ),
    )
    .orderBy(asc(ubicacion.nombre));

  for (const { productoId, ...datos } of filas) {
    if (!porProducto.has(productoId)) {
      porProducto.set(productoId, []);
    }
    porProducto.get(productoId).push(datos);
  }

  return porProducto;
}

/**
 * Las alertas activas del comercio, de la mas urgente a la menos.
 *
 * Urgencia es cuanto falta para volver al umbral (`stock - umbral`, mas
 * negativo primero), el mismo orden que usa `productosParaReponer` en el
 * asistente. Desempata por nombre y por id para que la paginacion sea estable:
 * sin un desempate unico, dos alertas igual de urgentes pueden cambiar de
 * lugar entre una pagina y otra y una termina repetida y la otra salteada.
 *
 * `stockActual` y `umbralMinimo` son los valores VIVOS, no los que la alerta
 * guardo al nacer: el panel muestra como esta el producto ahora. Los de la
 * foto van aparte (`stockAlGenerar`, `umbralAlGenerar`), que es lo que permite
 * ver que el stock siguio bajando desde que salto la alerta.
 *
 * Los productos dados de baja (HU-9) no aparecen aunque tengan una alerta
 * activa: no hay nada que reponer de algo que ya no se vende.
 *
 * Sin transaccion: son lecturas sobre datos que el dashboard refresca cada
 * pocos segundos igual, y envolverlas daria la ilusion de un invariante que no
 * hace falta sostener.
 */
export async function listarAlertasActivas(comercioId, query = {}) {
  const filtros = validarFiltrosAlertas(query);

  const donde = and(
    eq(alerta.comercioId, comercioId),
    eq(alerta.estado, "activa"),
    eq(producto.activo, true),
  );

  const [filas, [agregado]] = await Promise.all([
    db
      .select({
        id: alerta.id,
        generadaEn: alerta.createdAt,
        stockAlGenerar: alerta.stockAlGenerar,
        umbralAlGenerar: alerta.umbralAlGenerar,
        productoId: producto.id,
        productoNombre: producto.nombre,
        productoCodigoBarras: producto.codigoBarras,
        productoCategoria: producto.categoria,
        productoUnidadMedida: producto.unidadMedida,
        umbralMinimo: producto.umbralMinimo,
        enStock: TOTAL_EN_STOCK.mapWith(Number),
      })
      .from(alerta)
      // inner join: `producto_id` es NOT NULL con `cascade`, asi que toda
      // alerta tiene su producto.
      .innerJoin(producto, eq(producto.id, alerta.productoId))
      .leftJoin(
        stock,
        and(
          eq(stock.productoId, producto.id),
          eq(stock.comercioId, comercioId),
        ),
      )
      .where(donde)
      // Por las dos PK y nada mas: Postgres deja seleccionar el resto de las
      // columnas de una tabla agrupada por su clave primaria, porque dependen
      // funcionalmente de ella.
      .groupBy(alerta.id, producto.id)
      .orderBy(
        sql`${TOTAL_EN_STOCK} - ${producto.umbralMinimo} asc`,
        asc(producto.nombre),
        asc(alerta.id),
      )
      .limit(filtros.limite)
      .offset((filtros.pagina - 1) * filtros.limite),
    db
      .select({ total: count() })
      .from(alerta)
      .innerJoin(producto, eq(producto.id, alerta.productoId))
      .where(donde),
  ]);

  const productoIds = filas.map((fila) => fila.productoId);

  // Dos consultas para toda la pagina, no una por alerta.
  const [ubicaciones, proveedores] = await Promise.all([
    ubicacionesDeProductos(comercioId, productoIds),
    proveedoresDeProductos(comercioId, productoIds),
  ]);

  const total = agregado.total;

  return {
    alertas: filas.map((fila) => {
      // Todos los proveedores y no solo el sugerido: la relacion es N:M (ver
      // references/data-model.md) y quedarse con uno escondería que hay otros
      // a quien pedirle. El sugerido es el primero por nombre —el orden lo da
      // `proveedoresDeProductos`—, que es un criterio estable y no una
      // preferencia inventada: el modelo no guarda cual es el principal.
      const deEsteProducto = proveedores.get(fila.productoId) ?? [];

      return {
        id: fila.id,
        generadaEn: fila.generadaEn,
        producto: {
          id: fila.productoId,
          nombre: fila.productoNombre,
          codigoBarras: fila.productoCodigoBarras,
          categoria: fila.productoCategoria,
          unidadMedida: fila.productoUnidadMedida,
        },
        stockActual: fila.enStock,
        umbralMinimo: fila.umbralMinimo,
        // Explicito para que el Frontend no tenga que restar. Los productos
        // justo en el umbral dan 0, que es correcto: alcanzaron el minimo.
        faltanteHastaElUmbral: Math.max(fila.umbralMinimo - fila.enStock, 0),
        stockAlGenerar: fila.stockAlGenerar,
        umbralAlGenerar: fila.umbralAlGenerar,
        ubicaciones: ubicaciones.get(fila.productoId) ?? [],
        proveedorSugerido: deEsteProducto[0] ?? null,
        proveedores: deEsteProducto,
      };
    }),
    paginacion: {
      pagina: filtros.pagina,
      limite: filtros.limite,
      total,
      totalPaginas: Math.ceil(total / filtros.limite),
    },
  };
}
