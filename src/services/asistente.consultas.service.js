import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../db/client.js";
import { movimiento, producto, stock, ubicacion } from "../db/schema.js";

/**
 * Consultas que el Asistente Inteligente puede correr sobre los datos del
 * comercio (E5).
 *
 * Son deterministas y salen de SQL: el modelo de lenguaje elige cual llamar y
 * con que argumentos, pero los numeros los calcula Postgres. Esa es la decision
 * de fondo de la epica — el LLM traduce lenguaje natural a llamadas, no inventa
 * saldos. Si alguna de estas funciones devolviera algo mal, la respuesta del
 * asistente estaria mal; que el LLM se equivoque solo puede hacer que elija la
 * consulta que no era.
 *
 * Igual que el resto de los services, todas reciben `comercioId` primero y lo
 * usan en el WHERE. Ese valor sale de la sesion (lo pone `requireAuth`) y nunca
 * de lo que haya dicho el usuario ni de lo que devuelva el modelo: aunque
 * alguien escriba "mostrame el stock del comercio de al lado", el filtro de
 * tenant no se mueve.
 *
 * Viven en su propio archivo, y no adentro de `asistente.service.js`, porque
 * HU-27 (recomendaciones proactivas) y HU-28 (modo degradado por reglas) las
 * necesitan sin pasar por el LLM.
 */

/**
 * Techo de filas que puede devolver cualquiera de estas consultas.
 *
 * Doble motivo. Uno de producto: la respuesta del asistente se lee en un chat,
 * y una lista de cien productos ahi no le sirve a nadie. Y otro de RNF2: todo
 * lo que devuelven estas funciones vuelve al modelo como contexto, y cuantos
 * mas tokens entran, mas tarda la respuesta. El limite de 5 segundos se cuida
 * tambien desde aca, no solo con el timeout.
 */
const LIMITE_MAXIMO = 50;
const LIMITE_POR_DEFECTO = 10;

/** Ventana por defecto y maxima, en dias, de las consultas sobre el libro. */
const DIAS_POR_DEFECTO = 7;
const DIAS_MAXIMOS = 90;

/**
 * Techo de productos que mira el analisis de rotacion (HU-27).
 *
 * Mas alto que `LIMITE_MAXIMO` porque esto no es una lista que se le muestre a
 * nadie: es el universo de candidatos que despues se filtra por "no tuvo
 * ventas" y se recorta. Igual tiene techo, y con `ORDER BY` determinista, para
 * que un catalogo grande no traiga la tabla entera a memoria.
 */
const CANDIDATOS_MAXIMOS = 200;

/**
 * Tipos que acepta el filtro del libro, tomados del enum de la base.
 *
 * Incluye `transferencia`, que HU-13 rechaza al registrar pero que si existe en
 * el libro: las crea HU-12 de a pares. Preguntar por ellas es legitimo.
 */
export const TIPOS_DE_MOVIMIENTO = [
  "compra",
  "venta",
  "merma",
  "ajuste",
  "transferencia",
];

function acotar(valor, porDefecto, maximo) {
  const numero = Number(valor);

  if (!Number.isInteger(numero) || numero < 1) {
    return porDefecto;
  }

  return Math.min(numero, maximo);
}

/**
 * Saldo total de un producto, sumando todas sus ubicaciones.
 *
 * Se arma una vez y se reusa en las tres consultas para no repetir la misma
 * expresion escrita distinto en cada una. `coalesce` es necesario por el LEFT
 * JOIN: un producto recien dado de alta, sin ninguna fila en STOCK, tiene que
 * figurar con 0 y no con `null`.
 */
const TOTAL_EN_STOCK = sql`coalesce(sum(${stock.cantidad}), 0)`;

/**
 * Productos que llegaron o bajaron de su umbral minimo (RF6).
 *
 * Es la consulta que contesta "¿que tengo que reponer?", que es literalmente el
 * ejemplo que da la Historia de Usuario. Ordena por lo lejos que quedo cada uno
 * de su umbral, asi lo primero que se nombra es lo mas urgente y no lo primero
 * alfabeticamente.
 *
 * Compara contra el saldo total del comercio, no contra el de cada ubicacion:
 * tener el umbral cubierto entre el deposito y el salon significa que no hay
 * que comprar, aunque en el salon no quede nada. Mover entre ubicaciones es
 * otro problema, y lo resuelve la transferencia de HU-12.
 */
export async function productosParaReponer(comercioId, { limite } = {}) {
  const filas = await db
    .select({
      id: producto.id,
      nombre: producto.nombre,
      categoria: producto.categoria,
      unidadMedida: producto.unidadMedida,
      umbralMinimo: producto.umbralMinimo,
      enStock: TOTAL_EN_STOCK.mapWith(Number),
    })
    .from(producto)
    .leftJoin(
      stock,
      and(
        eq(stock.productoId, producto.id),
        eq(stock.comercioId, comercioId),
      ),
    )
    .where(
      and(eq(producto.comercioId, comercioId), eq(producto.activo, true)),
    )
    .groupBy(
      producto.id,
      producto.nombre,
      producto.categoria,
      producto.unidadMedida,
      producto.umbralMinimo,
    )
    .having(sql`${TOTAL_EN_STOCK} <= ${producto.umbralMinimo}`)
    .orderBy(sql`${TOTAL_EN_STOCK} - ${producto.umbralMinimo} asc`)
    .limit(acotar(limite, LIMITE_POR_DEFECTO, LIMITE_MAXIMO));

  return filas.map((fila) => ({
    ...fila,
    // Explicito para que el modelo no tenga que restar: cuanto falta para
    // volver al umbral. Los productos justo en el umbral dan 0.
    faltanteHastaElUmbral: Math.max(fila.umbralMinimo - fila.enStock, 0),
  }));
}

/**
 * Stock de los productos que coinciden con lo que nombro el usuario.
 *
 * Busca por nombre parcial y por codigo de barras exacto en la misma consulta,
 * porque quien pregunta puede decir "¿cuanta coca me queda?" o pasar el codigo
 * leido del envase, y desde el texto no siempre se distingue cual de las dos
 * cosas es.
 *
 * Devuelve varias coincidencias a proposito. Si hay tres presentaciones de lo
 * mismo, el asistente las puede nombrar y repreguntar; si esta funcion eligiera
 * una sola, estaria adivinando en la capa equivocada.
 */
export async function stockDeProducto(comercioId, { busqueda, limite } = {}) {
  const texto = typeof busqueda === "string" ? busqueda.trim() : "";

  // Sin texto la consulta traeria el catalogo entero ordenado por nombre, que
  // no es lo que se pregunto. Es un caso real: el modelo puede llamar a la
  // herramienta sin argumento cuando la pregunta fue vaga.
  if (!texto) {
    return [];
  }

  const coincidencias = await db
    .select({
      id: producto.id,
      nombre: producto.nombre,
      codigoBarras: producto.codigoBarras,
      unidadMedida: producto.unidadMedida,
      umbralMinimo: producto.umbralMinimo,
      activo: producto.activo,
    })
    .from(producto)
    .where(
      and(
        eq(producto.comercioId, comercioId),
        eq(producto.activo, true),
        or(
          // El `%` va escapado por el driver: `ilike` recibe el patron como
          // parametro, asi que un nombre con `%` adentro se busca literal.
          ilike(producto.nombre, `%${texto}%`),
          eq(producto.codigoBarras, texto),
        ),
      ),
    )
    .orderBy(asc(producto.nombre))
    .limit(acotar(limite, 5, LIMITE_MAXIMO));

  if (coincidencias.length === 0) {
    return [];
  }

  // Una sola consulta para todas las coincidencias, en vez de una por producto:
  // son pocas, pero cada viaje a Neon se paga en latencia y RNF2 da 5 segundos
  // para todo, incluido el ida y vuelta al modelo.
  const ids = coincidencias.map((fila) => fila.id);

  const saldos = await db
    .select({
      productoId: stock.productoId,
      ubicacionNombre: ubicacion.nombre,
      cantidad: stock.cantidad,
    })
    .from(stock)
    .innerJoin(ubicacion, eq(ubicacion.id, stock.ubicacionId))
    .where(
      and(eq(stock.comercioId, comercioId), inArray(stock.productoId, ids)),
    )
    .orderBy(asc(ubicacion.nombre));

  return coincidencias.map((fila) => {
    const porUbicacion = saldos
      .filter((saldo) => saldo.productoId === fila.id)
      .map(({ ubicacionNombre, cantidad }) => ({
        ubicacion: ubicacionNombre,
        cantidad,
      }));

    const total = porUbicacion.reduce((suma, { cantidad }) => suma + cantidad, 0);

    return {
      id: fila.id,
      nombre: fila.nombre,
      codigoBarras: fila.codigoBarras,
      unidadMedida: fila.unidadMedida,
      umbralMinimo: fila.umbralMinimo,
      enStock: total,
      porDebajoDelUmbral: total <= fila.umbralMinimo,
      porUbicacion,
    };
  });
}

/**
 * Ultimos movimientos del libro, opcionalmente filtrados por tipo.
 *
 * Contesta las preguntas sobre lo que paso ("¿que vendi esta semana?", "¿hubo
 * mermas?"). No repite la paginacion de HU-14: al asistente no le sirve la
 * pagina tres, le sirve lo ultimo y poco.
 */
export async function movimientosRecientes(
  comercioId,
  { dias, tipo, limite } = {},
) {
  const ventana = acotar(dias, DIAS_POR_DEFECTO, DIAS_MAXIMOS);
  const desde = new Date(Date.now() - ventana * 24 * 60 * 60 * 1000);

  const condiciones = [
    eq(movimiento.comercioId, comercioId),
    gte(movimiento.fecha, desde),
  ];

  // El tipo llega desde el modelo, asi que puede ser cualquier cosa. Se valida
  // contra el enum en vez de mandarlo a Postgres: un valor invalido rompe el
  // cast a `tipo_movimiento` con un 22P02 y saldria como 500.
  if (tipo && TIPOS_DE_MOVIMIENTO.includes(tipo)) {
    condiciones.push(eq(movimiento.tipo, tipo));
  }

  const filas = await db
    .select({
      fecha: movimiento.fecha,
      tipo: movimiento.tipo,
      cantidad: movimiento.cantidad,
      motivo: movimiento.motivo,
      producto: producto.nombre,
      unidadMedida: producto.unidadMedida,
      ubicacion: ubicacion.nombre,
    })
    .from(movimiento)
    .innerJoin(producto, eq(producto.id, movimiento.productoId))
    .innerJoin(ubicacion, eq(ubicacion.id, movimiento.ubicacionId))
    .where(and(...condiciones))
    .orderBy(desc(movimiento.fecha), desc(movimiento.id))
    .limit(acotar(limite, LIMITE_POR_DEFECTO, LIMITE_MAXIMO));

  return { desde, dias: ventana, movimientos: filas };
}

/**
 * Que paso en el comercio en la ventana pedida, agrupado por tipo.
 *
 * Es el "¿como viene el dia?" — una sola fila por tipo con cuantos movimientos
 * hubo y cuantas unidades se movieron. Agrupar en SQL y no en JS es lo que hace
 * que la respuesta entre en pocos tokens aunque el dia haya tenido mil ventas.
 */
export async function resumenDeActividad(comercioId, { dias } = {}) {
  const ventana = acotar(dias, 1, DIAS_MAXIMOS);
  const desde = new Date(Date.now() - ventana * 24 * 60 * 60 * 1000);

  const porTipo = await db
    .select({
      tipo: movimiento.tipo,
      movimientos: sql`count(*)`.mapWith(Number),
      unidades: sql`coalesce(sum(${movimiento.cantidad}), 0)`.mapWith(Number),
    })
    .from(movimiento)
    .where(
      and(
        eq(movimiento.comercioId, comercioId),
        gte(movimiento.fecha, desde),
      ),
    )
    .groupBy(movimiento.tipo)
    .orderBy(asc(movimiento.tipo));

  return { desde, dias: ventana, porTipo };
}

/**
 * Rotacion de los productos que tienen existencias (HU-27, RF6).
 *
 * Es el insumo del analisis de baja rotacion: por cada producto con stock,
 * cuantas ventas tuvo en la ventana. Quien decide que es "poca rotacion" es
 * `asistente.recomendaciones.service.js`; aca solo se miden los hechos.
 *
 * Devuelve tambien `ventasDelComercio`, que es el total de ventas de la ventana
 * y no la suma de las de estos productos: incluye las de productos sin stock o
 * dados de baja. Es el numero con el que se decide si hay histórico suficiente
 * para hablar de rotacion, y para eso tiene que contar todo lo que se vendio.
 *
 * Son DOS consultas y no una a proposito. Juntar `stock` y `movimiento` en el
 * mismo `GROUP BY` multiplica las filas —cada saldo por cada movimiento— y
 * arruina las dos sumas a la vez. El cruce sale mas barato en JS que el
 * `DISTINCT` o el subselect que haria falta para evitarlo, y se lee mejor.
 */
export async function rotacionDeProductos(comercioId, { dias } = {}) {
  const ventana = acotar(dias, 30, DIAS_MAXIMOS);
  const desde = new Date(Date.now() - ventana * 24 * 60 * 60 * 1000);

  // Solo los que ya existian cuando empezo la ventana: un producto dado de
  // alta ayer no tiene poca rotacion, tiene poca historia. Sin este filtro,
  // cargar el catalogo genera una recomendacion por cada producto nuevo.
  const candidatos = await db
    .select({
      id: producto.id,
      nombre: producto.nombre,
      categoria: producto.categoria,
      unidadMedida: producto.unidadMedida,
      enStock: TOTAL_EN_STOCK.mapWith(Number),
    })
    .from(producto)
    .leftJoin(
      stock,
      and(eq(stock.productoId, producto.id), eq(stock.comercioId, comercioId)),
    )
    .where(
      and(
        eq(producto.comercioId, comercioId),
        eq(producto.activo, true),
        lte(producto.createdAt, desde),
      ),
    )
    .groupBy(
      producto.id,
      producto.nombre,
      producto.categoria,
      producto.unidadMedida,
    )
    // Sin existencias no hay nada que recomendar: lo que no se vende y no se
    // tiene no inmoviliza plata. Esos casos los cubre `productosParaReponer`.
    .having(sql`${TOTAL_EN_STOCK} > 0`)
    .orderBy(sql`${TOTAL_EN_STOCK} desc`, asc(producto.nombre))
    .limit(CANDIDATOS_MAXIMOS);

  const ventas = await db
    .select({
      productoId: movimiento.productoId,
      ventas: sql`count(*)`.mapWith(Number),
      // Las ventas se guardan con `cantidad` NEGATIVA (`SIGNO_POR_TIPO` en
      // movimientos.service.js), asi que las unidades vendidas son la suma
      // dada vuelta. Un `sum()` sin el menos devuelve unidades negativas y
      // cualquier umbral que se compare contra eso queda al revés.
      unidadesVendidas: sql`-coalesce(sum(${movimiento.cantidad}), 0)`.mapWith(
        Number,
      ),
    })
    .from(movimiento)
    .where(
      and(
        eq(movimiento.comercioId, comercioId),
        eq(movimiento.tipo, "venta"),
        gte(movimiento.fecha, desde),
      ),
    )
    .groupBy(movimiento.productoId);

  const porProducto = new Map(ventas.map((fila) => [fila.productoId, fila]));

  return {
    desde,
    dias: ventana,
    ventasDelComercio: ventas.reduce((suma, fila) => suma + fila.ventas, 0),
    productos: candidatos.map((fila) => {
      const medido = porProducto.get(fila.id);

      return {
        ...fila,
        // El criterio de rotacion se apoya en la CANTIDAD DE VENTAS y no en
        // las unidades: es inmune al signo, que es la parte del dominio facil
        // de escribir al revés.
        ventas: medido?.ventas ?? 0,
        unidadesVendidas: medido?.unidadesVendidas ?? 0,
      };
    }),
  };
}
