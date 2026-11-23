import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  movimiento,
  producto,
  proveedor,
  stock,
  ubicacion,
} from "../db/schema.js";
import { leerEnteroPositivo } from "./movimientos.service.js";

/**
 * KPIs principales del dashboard (HU-22, RF7, RNF2).
 *
 * Tres bloques, que son los que nombra la historia:
 *
 *   stock                 como esta el inventario AHORA (cache `stock`)
 *   rotacion              cuanto se vendio en la ventana y que se mueve
 *   comprasPorProveedor   a quien se le compro en la ventana y cuanto
 *
 * Solo lee. Todo sale de `stock` y del libro de `movimiento` (ver
 * references/data-model.md), siempre filtrado por el `comercioId` de la sesion,
 * que llega primero y nunca de la query string.
 *
 * ---------------------------------------------------------------------------
 * LIMITACION CONOCIDA: no hay montos.
 *
 * Igual que el historial de compras de HU-21: el modelo no guarda precios ni
 * costos (ni en `movimiento`, ni en `producto`, ni en `producto_proveedor`),
 * asi que los KPIs son de volumen —unidades y cantidad de operaciones—. Los
 * montos se devuelven explicitamente en `null` para que el Frontend no tenga
 * que adivinar si faltan o si son cero.
 * ---------------------------------------------------------------------------
 *
 * RNF2 (carga en menos de dos segundos) se sostiene con tres cosas:
 *
 * 1. Todo el calculo es UNA sentencia SQL agregada (ver `consultarKpis`): una
 *    conexion y una ida y vuelta a la base, y no filas traidas a JS: la
 *    respuesta pesa lo mismo con diez movimientos que con cien mil.
 * 2. El indice `movimiento_comercio_tipo_fecha_idx` (db/schema.js) es
 *    exactamente el filtro de las ventas y las compras de la ventana.
 * 3. Una cache por comercio que se invalida sola en cuanto cambia algo (ver
 *    `huellaDelComercio`), asi que "en tiempo real" no se negocia por
 *    velocidad: una venta recien registrada se ve en la proxima carga.
 */

export const DIAS_POR_DEFECTO = 30;
export const DIAS_MAXIMOS = 90;

/** Cuantos productos lista "los mas vendidos". */
export const LIMITE_MAS_VENDIDOS = 5;

/** Cuantos proveedores lista el bloque de compras; el resto va en `otros`. */
export const LIMITE_PROVEEDORES = 8;

/**
 * La zona en la que se cortan los dias de la serie y de la ventana.
 *
 * Fija y no por comercio: el sistema es para comercios argentinos y `comercio`
 * no guarda zona horaria (es la misma que usa el asistente para decir "hoy").
 * Argentina no tiene horario de verano desde 2009, por eso el inicio de un dia
 * se puede armar con el offset fijo de abajo sin una libreria de zonas.
 */
export const ZONA_HORARIA = "America/Argentina/Buenos_Aires";
const OFFSET_ZONA = "-03:00";

const DIA_MS = 24 * 60 * 60 * 1000;

/** "2026-11-22": el dia calendario de un instante, en la zona del comercio. */
export function diaEnZona(instante) {
  return instante.toLocaleDateString("en-CA", { timeZone: ZONA_HORARIA });
}

/**
 * La ventana de los KPIs: los ultimos `dias` dias calendario, HOY incluido.
 *
 * Por dias calendario y no por "las ultimas N*24 horas" a proposito: la serie
 * diaria de ventas tiene que tener exactamente `dias` barras completas, y con
 * una ventana movil la primera seria un pedazo de dia que parece un dia malo.
 *
 * Pura (recibe `ahora`) para poder testear los cortes de dia sin reloj.
 */
export function ventanaDeDias(dias, ahora = new Date()) {
  const hoy = diaEnZona(ahora);
  const inicioDeHoy = new Date(`${hoy}T00:00:00.000${OFFSET_ZONA}`);
  const desde = new Date(inicioDeHoy.getTime() - (dias - 1) * DIA_MS);

  const fechas = Array.from({ length: dias }, (_, i) =>
    diaEnZona(new Date(desde.getTime() + i * DIA_MS)),
  );

  return { dias, desde, hasta: ahora, hoy, fechas };
}

/**
 * Valida y normaliza la query string.
 *
 * Pura, como `validarFiltrosAlertas` (HU-17). Devuelve solo los campos
 * conocidos: un `comercioId` que venga en la URL se pierde aca. Reusa el
 * lector de HU-14 para que el 400 diga lo mismo que en el resto de la API.
 */
export function validarParametrosKpis(query = {}) {
  const dias = leerEnteroPositivo(query.dias, DIAS_POR_DEFECTO, "dias");

  // Se recorta en vez de rechazar, igual que el `limite` de HU-14 y HU-21:
  // pedir de mas no es un error del usuario, y el tope solo protege a la base.
  return { dias: Math.min(dias, DIAS_MAXIMOS) };
}

/**
 * Los dias sin ventas tambien son dias.
 *
 * La consulta agrupada solo devuelve los dias que tuvieron alguna venta; el
 * grafico necesita una barra por dia de la ventana, con 0 donde no hubo nada,
 * para que un hueco se vea como hueco y no como dos dias pegados.
 */
export function completarSerie(fechas, filas) {
  const porDia = new Map(filas.map((fila) => [fila.fecha, fila]));

  return fechas.map((fecha) => ({
    fecha,
    ventas: porDia.get(fecha)?.ventas ?? 0,
    unidades: porDia.get(fecha)?.unidades ?? 0,
  }));
}

/**
 * Para cuantos dias alcanza el stock al ritmo de venta de la ventana.
 *
 * Es la forma operativa de la rotacion: "me quedan 4 dias de yerba" se decide
 * solo, un indice abstracto no. Redondea para abajo —3,9 dias son 3, no 4—
 * porque prometer un dia que no hay es peor que avisar uno antes. `null` si no
 * se vendio nada: sin ritmo de venta no hay cobertura que calcular, y un
 * `Infinity` no viaja en JSON.
 */
export function diasDeCobertura(stockActual, unidadesVendidas, dias) {
  if (!(unidadesVendidas > 0) || !(dias > 0)) {
    return null;
  }

  return Math.floor(Math.max(stockActual, 0) / (unidadesVendidas / dias));
}


/**
 * Arma el bloque de compras a partir de los grupos.
 *
 * Pura, para testear el recorte sin base. Los totales se calculan sobre TODOS
 * los grupos, antes de recortar: un total que depende de cuantos proveedores
 * entran en el grafico no es un total. Lo que no entra va sumado en `otros`.
 */
export function resumirCompras(grupos, limite = LIMITE_PROVEEDORES) {
  const conProveedor = grupos.filter((grupo) => grupo.id !== null);
  const sinProveedor = grupos.find((grupo) => grupo.id === null);

  const sumar = (lista, campo) =>
    lista.reduce((suma, grupo) => suma + grupo[campo], 0);

  const visibles = conProveedor.slice(0, limite);
  const resto = conProveedor.slice(limite);

  return {
    compras: sumar(grupos, "compras"),
    unidades: sumar(grupos, "unidades"),
    proveedoresConCompras: conProveedor.length,
    proveedores: visibles.map((grupo) => ({
      proveedor: { id: grupo.id, nombre: grupo.nombre, activo: grupo.activo },
      compras: grupo.compras,
      unidades: grupo.unidades,
      ultimaCompra: grupo.ultimaCompra ?? null,
    })),
    otros:
      resto.length > 0
        ? {
            proveedores: resto.length,
            compras: sumar(resto, "compras"),
            unidades: sumar(resto, "unidades"),
          }
        : null,
    sinProveedor: sinProveedor
      ? { compras: sinProveedor.compras, unidades: sinProveedor.unidades }
      : null,
    // Ver la limitacion del encabezado: el modelo no tiene precios.
    montos: null,
  };
}


/* ---------------------------------------------------------------------------
 * Consulta
 * ------------------------------------------------------------------------- */

/**
 * Todo el calculo es UNA sola sentencia SQL, y eso es lo que sostiene RNF2.
 *
 * La primera version eran cinco consultas en paralelo. Contra Neon —remota,
 * ~200 ms de ida y vuelta desde la maquina de desarrollo— eso costaba poco en
 * red, pero obligaba al pool a abrir cinco conexiones a la vez, y cada conexion
 * nueva a Neon tarda mas de un segundo (TLS + autenticacion). El E2E midio el
 * dashboard en 3,5 s y el endpoint en frio en 2,2 s; con una sola sentencia es
 * una conexion y una ida y vuelta, gane quien gane la carrera del pool.
 *
 * Dos ganancias mas, de yapa:
 *
 * - Toda la respuesta sale de la MISMA foto de la base (una sentencia ve un
 *   unico snapshot). Con cinco consultas sueltas, una venta que confirmaba en el
 *   medio podia quedar contada en la rotacion y no en el stock.
 * - La huella de la cache (ver `huellaDelComercio`) va en la misma sentencia,
 *   asi que lo que se guarda en la cache y la huella con la que se guarda son
 *   exactamente del mismo momento.
 *
 * Cada bloque devuelve JSON armado en Postgres (`json_build_object` /
 * `json_agg`), con los nombres de campo que espera la respuesta. Los conteos y
 * las sumas llegan como numeros JSON, no como el string del `bigint`.
 *
 * Columnas por nombre literal y tablas por `${tabla}` de Drizzle: el SQL se lee
 * de corrido y, si una tabla cambia de nombre en el schema, esto la sigue.
 * Todos los valores van como parametros; lo unico literal es la zona horaria,
 * que es una constante del modulo (ver `DIA_LOCAL`).
 */

/**
 * El dia calendario de un movimiento, en la zona del comercio.
 *
 * `fecha` es `timestamp` sin zona y guarda la hora UTC (Drizzle la escribe con
 * `toISOString()`), asi que primero se la declara UTC y despues se la pasa a
 * la zona local. La zona va como literal (`sql.raw`) y no como parametro para
 * que el `GROUP BY 1` agrupe por la expresion del SELECT tal cual.
 */
const DIA_LOCAL = sql.raw(
  `to_char((m.fecha at time zone 'UTC') at time zone '${ZONA_HORARIA}', 'YYYY-MM-DD')`,
);

/** Un `timestamp` UTC como ISO con `Z`, que es lo que entrega el resto de la API. */
const ISO_UTC = (columna) =>
  sql.raw(`to_char(${columna}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);

/**
 * La huella de una tabla del comercio: cuantas filas tiene y la suma de sus
 * `updated_at`. Ver `huellaDelComercio` para por que la suma y no el maximo.
 */
function resumenDeTabla(tabla, comercioId, extra = sql``) {
  return sql`(
    select count(*)::text || ':' || coalesce(sum(extract(epoch from t.updated_at)), 0)::text ${extra}
    from ${tabla} t
    where t.comercio_id = ${comercioId}
  )`;
}

/**
 * Una "foto" barata de todo lo que alimenta los KPIs de un comercio. Si
 * cualquier cosa cambia, la huella cambia y la cache se descarta:
 *
 * - Todo movimiento —venta, compra, ajuste, merma, transferencia— pasa por
 *   `aplicarMovimiento`, que hace upsert en `stock` con `updated_at` nuevo.
 *   Por eso no hace falta mirar el libro, que es la tabla que crece.
 * - Un umbral, un alta o una baja de producto mueven `producto.updated_at`;
 *   renombrar un proveedor o una ubicacion, el suyo.
 *
 * Se suma el `updated_at` (en segundos) en vez de tomar el maximo: con el
 * maximo, una escritura que confirma despues pero con un reloj apenas anterior
 * no se notaria. La suma cambia con cualquier fila que cambie.
 *
 * Son cuatro subconsultas sobre tablas chicas (productos, ubicaciones y
 * proveedores del comercio, no movimientos), todas por `comercio_id`, que
 * tiene indice.
 */
function huellaSql(comercioId) {
  return sql`concat_ws('|',
    ${resumenDeTabla(stock, comercioId, sql`|| ':' || coalesce(sum(t.cantidad), 0)::text`)},
    ${resumenDeTabla(producto, comercioId)},
    ${resumenDeTabla(proveedor, comercioId)},
    ${resumenDeTabla(ubicacion, comercioId)}
  )`;
}

/** Solo la huella: es lo unico que se consulta cuando hay algo en la cache. */
async function huellaDelComercio(comercioId) {
  const { rows } = await db.execute(sql`select ${huellaSql(comercioId)} as huella`);
  return rows[0].huella;
}

/**
 * Los cinco bloques y la huella, en una sentencia.
 *
 * Las reglas de cada bloque son las que documenta la respuesta en
 * `routes/kpis.routes.js`; las no obvias, al lado de cada parte:
 *
 * - `ventas` (CTE): las ventas de la ventana por producto. Se guardan con
 *   `cantidad` NEGATIVA (`SIGNO_POR_TIPO` en movimientos.service.js), asi que
 *   las unidades vendidas son la suma dada vuelta, como en el asistente.
 * - `saldos` (CTE): el total de cada producto ACTIVO, sumando ubicaciones.
 * - estado: `sinStock`, `bajoUmbral` y `normal` son excluyentes. "Bajo umbral"
 *   es "en o por debajo" (el criterio de la alerta de HU-17) y un umbral en 0
 *   es "sin umbral". `productosSinVentas` solo cuenta los que ya existian al
 *   empezar la ventana, el mismo recorte que el asistente de HU-27.
 * - por ubicacion: arranca de `ubicacion` para que una vacia aparezca con 0;
 *   los productos dados de baja no suman.
 * - mas vendidos: incluye productos dados de baja —si se vendieron, se
 *   vendieron— y desempata por nombre e id para que el ranking sea estable.
 * - compras: solo `tipo = compra` (un ajuste positivo o la pata de destino de
 *   una transferencia son entradas, no compras a un proveedor, como en HU-21).
 *   Las compras sin proveedor quedan en el grupo con `id` nulo.
 *
 * Las ventas y las compras de la ventana se leen por el indice
 * `movimiento_comercio_tipo_fecha_idx`, que es exactamente ese filtro.
 */
async function consultarKpis(comercioId, desde) {
  // ISO explicito: en un `sql` crudo el driver serializaria el Date con la zona
  // del proceso, y contra un `timestamp` sin zona Postgres la descartaria.
  const desdeIso = desde.toISOString();

  const { rows } = await db.execute(sql`
    with ventas as (
      select m.producto_id,
             count(*) as ventas,
             -coalesce(sum(m.cantidad), 0) as unidades
      from ${movimiento} m
      where m.comercio_id = ${comercioId}
        and m.tipo = 'venta'
        and m.fecha >= ${desdeIso}::timestamp
      group by m.producto_id
    ),
    saldos as (
      select p.id,
             p.umbral_minimo as umbral,
             p.created_at,
             coalesce(sum(s.cantidad), 0) as total
      from ${producto} p
      left join ${stock} s on s.producto_id = p.id and s.comercio_id = ${comercioId}
      where p.comercio_id = ${comercioId} and p.activo
      group by p.id
    )
    select
      (
        select json_build_object(
          'productos', count(*),
          'unidades', coalesce(sum(sa.total), 0),
          'sinStock', count(*) filter (where sa.total <= 0),
          'bajoUmbral', count(*) filter (
            where sa.total > 0 and sa.umbral > 0 and sa.total <= sa.umbral
          ),
          'productosSinVentas', count(*) filter (
            where sa.total > 0
              and sa.created_at <= ${desdeIso}::timestamp
              and v.producto_id is null
          )
        )
        from saldos sa
        left join ventas v on v.producto_id = sa.id
      ) as estado,

      (
        select coalesce(json_agg(u order by u.nombre), '[]'::json)
        from (
          select ub.id,
                 ub.nombre,
                 coalesce(sum(s.cantidad) filter (where p.activo), 0) as unidades,
                 count(distinct s.producto_id) filter (
                   where p.activo and s.cantidad > 0
                 ) as productos
          from ${ubicacion} ub
          left join ${stock} s on s.ubicacion_id = ub.id and s.comercio_id = ${comercioId}
          left join ${producto} p on p.id = s.producto_id
          where ub.comercio_id = ${comercioId}
          group by ub.id
        ) u
      ) as por_ubicacion,

      (
        select coalesce(
          json_agg(mv order by mv.unidades desc, mv.nombre, mv.id),
          '[]'::json
        )
        from (
          select p.id,
                 p.nombre,
                 p.categoria,
                 p.unidad_medida as "unidadMedida",
                 p.activo,
                 v.ventas,
                 v.unidades,
                 (
                   select coalesce(sum(s.cantidad), 0)
                   from ${stock} s
                   where s.producto_id = p.id and s.comercio_id = ${comercioId}
                 ) as "stockActual"
          from ventas v
          join ${producto} p on p.id = v.producto_id
          order by v.unidades desc, p.nombre, p.id
          limit ${LIMITE_MAS_VENDIDOS}
        ) mv
      ) as mas_vendidos,

      (
        select coalesce(json_agg(d), '[]'::json)
        from (
          select ${DIA_LOCAL} as fecha,
                 count(*) as ventas,
                 -coalesce(sum(m.cantidad), 0) as unidades
          from ${movimiento} m
          where m.comercio_id = ${comercioId}
            and m.tipo = 'venta'
            and m.fecha >= ${desdeIso}::timestamp
          group by 1
        ) d
      ) as por_dia,

      (
        select coalesce(
          json_agg(c order by c.unidades desc, c.nombre, c.id),
          '[]'::json
        )
        from (
          select pr.id,
                 pr.nombre,
                 pr.activo,
                 count(*) as compras,
                 coalesce(sum(m.cantidad), 0) as unidades,
                 ${ISO_UTC("max(m.fecha)")} as "ultimaCompra"
          from ${movimiento} m
          left join ${proveedor} pr on pr.id = m.proveedor_id
          where m.comercio_id = ${comercioId}
            and m.tipo = 'compra'
            and m.fecha >= ${desdeIso}::timestamp
          group by pr.id
        ) c
      ) as compras,

      ${huellaSql(comercioId)} as huella
  `);

  return rows[0];
}

/** Calcula todo, sin cache, y devuelve tambien la huella de ese momento. */
async function calcularKpis(comercioId, ventana) {
  const fila = await consultarKpis(comercioId, ventana.desde);
  const estado = fila.estado;
  const serie = completarSerie(ventana.fechas, fila.por_dia);

  const kpis = {
    generadoEn: new Date(),
    periodo: {
      dias: ventana.dias,
      desde: ventana.desde,
      hasta: ventana.hasta,
      zonaHoraria: ZONA_HORARIA,
    },
    stock: {
      productos: estado.productos,
      unidades: estado.unidades,
      sinStock: estado.sinStock,
      bajoUmbral: estado.bajoUmbral,
      normal: estado.productos - estado.sinStock - estado.bajoUmbral,
      productosSinVentas: estado.productosSinVentas,
      porUbicacion: fila.por_ubicacion,
    },
    rotacion: {
      // Sale de la serie y no de otra cuenta: la suma de los dias ES el total
      // de la ventana, y asi no pueden contradecirse.
      ventas: serie.reduce((suma, dia) => suma + dia.ventas, 0),
      unidadesVendidas: serie.reduce((suma, dia) => suma + dia.unidades, 0),
      productosSinVentas: estado.productosSinVentas,
      masVendidos: fila.mas_vendidos.map((mv) => ({
        producto: {
          id: mv.id,
          nombre: mv.nombre,
          categoria: mv.categoria,
          unidadMedida: mv.unidadMedida,
          activo: mv.activo,
        },
        ventas: mv.ventas,
        unidadesVendidas: mv.unidades,
        stockActual: mv.stockActual,
        diasDeCobertura: diasDeCobertura(mv.stockActual, mv.unidades, ventana.dias),
      })),
      porDia: serie,
      montos: null,
    },
    comprasPorProveedor: resumirCompras(fila.compras),
  };

  return { kpis, huella: fila.huella };
}

/* ---------------------------------------------------------------------------
 * Cache
 * ------------------------------------------------------------------------- */

/**
 * Tope de vida de una entrada aunque la huella no cambie. Es la red de abajo:
 * la huella detecta cualquier escritura normal, y esto acota lo que se pudiera
 * escapar.
 */
const CACHE_TTL_MS = 60 * 1000;

/** Tope de entradas, para que la cache no crezca sin limite con los comercios. */
const CACHE_MAXIMO = 500;

const cacheDeKpis = new Map();

/** Para los tests: cada uno arranca sin lo que dejo el anterior. */
export function limpiarCacheDeKpis() {
  cacheDeKpis.clear();
}

/**
 * Los KPIs del comercio para el dashboard.
 *
 * - Sin nada en la cache: se calcula directo, sin preguntar antes la huella
 *   (seria una ida y vuelta a la base para comparar contra nada).
 * - Con algo en la cache: se lee solo la huella, que es barata, y si coincide
 *   se devuelve lo guardado. Si no, se recalcula.
 *
 * La huella guardada es la que vino en la MISMA sentencia que los numeros, asi
 * que nunca puede quedar un calculo viejo guardado con una huella nueva.
 *
 * La clave lleva el dia: a medianoche la ventana se corre, y lo que se calculo
 * ayer ya no es la misma ventana aunque no haya cambiado nada.
 *
 * Sin transaccion: es una sola sentencia, que ya ve un unico snapshot.
 */
export async function obtenerKpis(comercioId, query = {}) {
  const { dias } = validarParametrosKpis(query);
  const ventana = ventanaDeDias(dias);
  const clave = `${comercioId}|${dias}|${ventana.hoy}`;

  const guardado = cacheDeKpis.get(clave);

  if (guardado && guardado.expiraEn > Date.now()) {
    const huella = await huellaDelComercio(comercioId);
    if (huella === guardado.huella) {
      return guardado.kpis;
    }
  }

  const { kpis, huella } = await calcularKpis(comercioId, ventana);

  // Se borra antes de volver a poner para que la entrada quede al final del
  // Map, que recuerda el orden de insercion: asi la primera es la mas vieja y
  // es la que se descarta al llegar al tope.
  cacheDeKpis.delete(clave);
  cacheDeKpis.set(clave, {
    huella,
    kpis,
    expiraEn: Date.now() + CACHE_TTL_MS,
  });

  if (cacheDeKpis.size > CACHE_MAXIMO) {
    cacheDeKpis.delete(cacheDeKpis.keys().next().value);
  }

  return kpis;
}
