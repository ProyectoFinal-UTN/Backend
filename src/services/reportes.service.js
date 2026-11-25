import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  movimiento,
  producto,
  proveedor,
  tipoMovimiento,
  ubicacion,
} from "../db/schema.js";
import { ErrorDeNegocio, esUuid } from "../lib/errores.js";
import {
  esZonaHorariaValida,
  formatearFechaHora,
  generarPdfTabular,
} from "../lib/plantillaPdf.js";
import { obtenerPerfil } from "./comercios.service.js";
import { exigirProveedorDelHistorial } from "./comprasProveedor.service.js";
import { leerInstante } from "./movimientos.service.js";

/**
 * Reportes de movimientos exportables en PDF (HU-25, RF8).
 *
 * Lee el libro de movimientos con los mismos criterios que el historial de
 * HU-14 y el de compras de HU-21 —sin filtrar productos ni proveedores dados de
 * baja, que siguen teniendo historia— y lo vuelca en la plantilla de
 * `lib/plantillaPdf.js`. No escribe nada.
 *
 * El `comercioId` llega primero y sale siempre de la sesion, nunca de la query
 * string.
 *
 * ---------------------------------------------------------------------------
 * LIMITACION CONOCIDA: el reporte no tiene montos.
 *
 * Igual que HU-21: `movimiento` no guarda precio ni costo y no hay ningun campo
 * monetario en el modelo. Inventar montos en un documento que se archiva seria
 * peor que no tenerlos, asi que el PDF informa cantidades y lo dice en una nota.
 * Cuando el modelo tenga precios, se suma la columna aca.
 * ---------------------------------------------------------------------------
 */

export const TIPOS_REPORTE = ["periodo", "producto", "proveedor"];

/**
 * Zona con la que se muestran las fechas si el cliente no manda otra. El
 * comercio no guarda su zona (HU-6 no la pide) y el producto apunta a PyMEs de
 * Argentina.
 */
export const ZONA_HORARIA_POR_DEFECTO = "America/Argentina/Buenos_Aires";

/**
 * Tope de filas por reporte. El PDF se arma entero en memoria antes de
 * mandarlo, y 5000 filas son unas 100 hojas: mas que eso no es un reporte que
 * alguien vaya a leer. Pasado el tope se rechaza en vez de cortar: un archivo
 * que se guarda como registro no puede omitir movimientos sin que se note.
 */
export const MAXIMO_FILAS_REPORTE = 5000;

/** Los parametros que solo tienen sentido en un tipo de reporte. */
const PARAMETRO_DEL_TIPO = {
  productoId: "producto",
  proveedorId: "proveedor",
};

const TITULO_POR_TIPO = {
  periodo: "Reporte de movimientos por período",
  producto: "Reporte de movimientos por producto",
  proveedor: "Reporte de movimientos por proveedor",
};

const NOMBRE_DEL_TIPO = {
  periodo: "Por período",
  producto: "Por producto",
  proveedor: "Por proveedor",
};

const ETIQUETA_MOVIMIENTO = {
  compra: "Compra",
  venta: "Venta",
  ajuste: "Ajuste",
  merma: "Merma",
  transferencia: "Transferencia",
};

const PLURAL_MOVIMIENTO = {
  compra: "Compras",
  venta: "Ventas",
  ajuste: "Ajustes",
  merma: "Mermas",
  transferencia: "Transferencias",
};

const vacio = (valor) => valor === undefined || valor === null || valor === "";

/**
 * Valida y normaliza los parametros del reporte.
 *
 * Pura, sin base, para testearla sola como `validarFiltrosHistorial`. Devuelve
 * solo los campos conocidos: un `comercioId` que venga en la query se pierde
 * aca.
 *
 * El rango es obligatorio en los tres tipos: el criterio de aceptacion pide que
 * el PDF diga el rango aplicado, y "desde siempre" no es un rango que se pueda
 * archivar y comparar con otro. Las fechas se leen con `leerInstante` de HU-14
 * (ISO 8601 con zona, mismos mensajes): el cliente resuelve donde empieza y
 * termina el dia del usuario.
 *
 * Un `productoId` en un reporte por periodo se rechaza y no se ignora, por lo
 * mismo que HU-21 no acepta filtros que no usa: un PDF que dice "por periodo"
 * cuando el usuario creyo filtrar un producto es un archivo que miente.
 */
export function validarParametrosReporte(query = {}) {
  if (vacio(query.tipo)) {
    throw new ErrorDeNegocio(
      `Falta el parámetro "tipo". Los aceptados son: ${TIPOS_REPORTE.join(", ")}`,
      400,
    );
  }

  const tipo =
    typeof query.tipo === "string" ? query.tipo.trim().toLowerCase() : "";

  if (!TIPOS_REPORTE.includes(tipo)) {
    throw new ErrorDeNegocio(
      `El tipo de reporte no es válido. Los aceptados son: ${TIPOS_REPORTE.join(", ")}`,
      400,
    );
  }

  for (const nombre of ["desde", "hasta"]) {
    if (vacio(query[nombre])) {
      throw new ErrorDeNegocio(
        `Falta el parámetro "${nombre}": el reporte necesita un rango de fechas`,
        400,
      );
    }
  }

  const desde = leerInstante(query.desde, "desde");
  const hasta = leerInstante(query.hasta, "hasta");

  if (desde > hasta) {
    throw new ErrorDeNegocio(
      'La fecha "desde" no puede ser posterior a la fecha "hasta"',
      400,
    );
  }

  for (const [parametro, tipoQueLoUsa] of Object.entries(PARAMETRO_DEL_TIPO)) {
    const presente = !vacio(query[parametro]);

    if (tipo === tipoQueLoUsa && !presente) {
      throw new ErrorDeNegocio(
        `Falta el parámetro "${parametro}": el reporte por ${tipoQueLoUsa} lo necesita`,
        400,
      );
    }

    if (tipo !== tipoQueLoUsa && presente) {
      throw new ErrorDeNegocio(
        `El parámetro "${parametro}" solo se usa en el reporte por ${tipoQueLoUsa}`,
        400,
      );
    }
  }

  const zonaHoraria = vacio(query.zonaHoraria)
    ? ZONA_HORARIA_POR_DEFECTO
    : query.zonaHoraria;

  if (!esZonaHorariaValida(zonaHoraria)) {
    throw new ErrorDeNegocio(
      `La zona horaria no es válida. Tiene que ser un nombre IANA, por ejemplo ${ZONA_HORARIA_POR_DEFECTO}`,
      400,
    );
  }

  return {
    tipo,
    desde,
    hasta,
    // Crudos: el UUID se valida al buscarlos, para que un id roto sea el
    // mismo 404 que uno que no existe.
    productoId: tipo === "producto" ? query.productoId : undefined,
    proveedorId: tipo === "proveedor" ? query.proveedorId : undefined,
    zonaHoraria,
  };
}

/**
 * El producto del reporte, sin filtrar por `activo`.
 *
 * A diferencia de `exigirProductoDelComercio` (HU-13), que es para registrar y
 * por eso exige que este activo: un producto dado de baja sigue teniendo
 * historia, y el reporte de lo que se movio antes de la baja es justo lo que
 * alguien querria archivar. Es la misma regla que el historial de HU-14.
 *
 * 404 y no 403 cuando es de otro comercio, con el mismo mensaje que cuando no
 * existe, y tambien para un id que no es UUID (si no, Postgres tira 22P02 y
 * sale un 500).
 */
async function exigirProductoDelReporte(comercioId, productoIdCrudo) {
  if (!esUuid(productoIdCrudo)) {
    throw new ErrorDeNegocio("El producto no existe", 404);
  }

  const [fila] = await db
    .select({
      id: producto.id,
      nombre: producto.nombre,
      codigoBarras: producto.codigoBarras,
      unidadMedida: producto.unidadMedida,
      activo: producto.activo,
    })
    .from(producto)
    .where(
      and(eq(producto.id, productoIdCrudo), eq(producto.comercioId, comercioId)),
    )
    .limit(1);

  if (!fila) {
    throw new ErrorDeNegocio("El producto no existe", 404);
  }

  return fila;
}

/**
 * Los movimientos del reporte, del mas viejo al mas nuevo: es un documento que
 * se lee de arriba hacia abajo como un libro, no una pantalla que muestra lo
 * ultimo primero.
 *
 * Se pide una fila de mas que el tope para saber si se paso sin contar aparte.
 */
async function leerMovimientos(comercioId, parametros) {
  const condiciones = [
    eq(movimiento.comercioId, comercioId),
    gte(movimiento.fecha, parametros.desde),
    lte(movimiento.fecha, parametros.hasta),
  ];

  if (parametros.productoId) {
    condiciones.push(eq(movimiento.productoId, parametros.productoId));
  }
  if (parametros.proveedorId) {
    condiciones.push(eq(movimiento.proveedorId, parametros.proveedorId));
  }

  const filas = await db
    .select({
      id: movimiento.id,
      fecha: movimiento.fecha,
      tipo: movimiento.tipo,
      cantidad: movimiento.cantidad,
      productoNombre: producto.nombre,
      productoUnidadMedida: producto.unidadMedida,
      ubicacionNombre: ubicacion.nombre,
      proveedorNombre: proveedor.nombre,
    })
    .from(movimiento)
    // inner joins: las dos FK son NOT NULL con `restrict`. El proveedor es left
    // join porque `proveedor_id` es nullable (ventas, ajustes, mermas).
    .innerJoin(producto, eq(producto.id, movimiento.productoId))
    .innerJoin(ubicacion, eq(ubicacion.id, movimiento.ubicacionId))
    .leftJoin(proveedor, eq(proveedor.id, movimiento.proveedorId))
    .where(and(...condiciones))
    // El id desempata movimientos del mismo instante (las dos patas de una
    // transferencia), para que dos PDF del mismo rango salgan iguales.
    .orderBy(asc(movimiento.fecha), asc(movimiento.id))
    .limit(MAXIMO_FILAS_REPORTE + 1);

  if (filas.length > MAXIMO_FILAS_REPORTE) {
    throw new ErrorDeNegocio(
      `El reporte supera los ${MAXIMO_FILAS_REPORTE} movimientos. Acotá el rango de fechas para generarlo`,
      400,
    );
  }

  return filas;
}

/**
 * Totales del reporte. Pura, para testearla sin base.
 *
 * Se calcula sobre las filas ya leidas y no con un SUM aparte: estan todas en
 * memoria (el tope lo garantiza) y asi el total no puede no coincidir con la
 * tabla que se imprime arriba.
 *
 * `porTipo` sigue el orden del enum y solo trae los tipos que aparecen.
 */
export function calcularTotales(movimientos) {
  let entradas = 0;
  let salidas = 0;
  const acumulado = new Map();

  for (const { tipo, cantidad } of movimientos) {
    if (cantidad > 0) {
      entradas += cantidad;
    } else {
      salidas -= cantidad;
    }

    const actual = acumulado.get(tipo) ?? { movimientos: 0, unidades: 0 };
    actual.movimientos += 1;
    actual.unidades += cantidad;
    acumulado.set(tipo, actual);
  }

  return {
    movimientos: movimientos.length,
    entradas,
    salidas,
    neto: entradas - salidas,
    porTipo: tipoMovimiento.enumValues
      .filter((tipo) => acumulado.has(tipo))
      .map((tipo) => ({ tipo, ...acumulado.get(tipo) })),
  };
}

const formatoNumero = new Intl.NumberFormat("es-AR");

const numero = (valor) => formatoNumero.format(valor);
const conSigno = (valor) => (valor > 0 ? `+${numero(valor)}` : numero(valor));

/** "aaaa-mm-dd" en la zona del reporte, para el nombre del archivo. */
function fechaParaArchivo(fecha, zonaHoraria) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zonaHoraria,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(fecha)
      .map((parte) => [parte.type, parte.value]),
  );

  return `${partes.year}-${partes.month}-${partes.day}`;
}

/** Sin tildes ni espacios: el nombre del archivo viaja en un header HTTP. */
function slugParaArchivo(texto) {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
}

/**
 * Nombre del archivo descargado, por ejemplo
 * `reporte-movimientos-producto-yerba-1kg-2026-09-01_2026-09-30.pdf`.
 *
 * Lleva el tipo, el producto o proveedor y el rango: archivados en una carpeta,
 * los reportes se distinguen sin abrirlos.
 */
export function nombreDeArchivo({ tipo, desde, hasta, zonaHoraria }, sujeto) {
  const partes = ["reporte-movimientos", tipo];
  const slug = sujeto ? slugParaArchivo(sujeto) : "";

  if (slug) {
    partes.push(slug);
  }

  partes.push(
    `${fechaParaArchivo(desde, zonaHoraria)}_${fechaParaArchivo(hasta, zonaHoraria)}`,
  );

  return `${partes.join("-")}.pdf`;
}

const conBaja = (nombre, activo) =>
  activo ? nombre : `${nombre} (dado de baja)`;

/** Las columnas de la tabla. La del filtro elegido se omite: se repetiria igual en cada fila. */
function columnasDelReporte(tipo, zonaHoraria) {
  return [
    {
      titulo: "Fecha",
      peso: 1.35,
      valor: (m) => formatearFechaHora(m.fecha, zonaHoraria),
    },
    { titulo: "Tipo", peso: 1.15, valor: (m) => ETIQUETA_MOVIMIENTO[m.tipo] },
    tipo !== "producto" && {
      titulo: "Producto",
      peso: 2.4,
      valor: (m) => m.productoNombre,
    },
    { titulo: "Ubicación", peso: 1.4, valor: (m) => m.ubicacionNombre },
    {
      titulo: "Cantidad",
      peso: 0.95,
      alineacion: "right",
      valor: (m) => conSigno(m.cantidad),
    },
    tipo !== "proveedor" && {
      titulo: "Proveedor",
      peso: 1.6,
      valor: (m) => m.proveedorNombre ?? "—",
    },
  ].filter(Boolean);
}

function totalesDelReporte(totales) {
  return [
    ["Movimientos", numero(totales.movimientos)],
    ["Unidades que entraron", numero(totales.entradas)],
    ["Unidades que salieron", numero(totales.salidas)],
    ["Saldo neto", conSigno(totales.neto)],
    ...totales.porTipo.map(({ tipo, movimientos, unidades }) => [
      PLURAL_MOVIMIENTO[tipo],
      `${numero(movimientos)} ${movimientos === 1 ? "movimiento" : "movimientos"}, ${conSigno(unidades)} unidades`,
    ]),
  ];
}

function notasDelReporte(movimientos) {
  const notas = [
    "Cantidades con signo: + es una entrada de stock y - una salida.",
    "Montos no disponibles: el sistema todavía no registra precios ni costos en los movimientos, por eso el reporte informa cantidades.",
  ];

  if (new Set(movimientos.map((m) => m.productoUnidadMedida)).size > 1) {
    notas.push(
      "Los totales suman productos con distintas unidades de medida sin convertirlas.",
    );
  }

  if (movimientos.some((m) => m.tipo === "transferencia")) {
    notas.push(
      "Cada transferencia entre ubicaciones aparece dos veces: la salida del origen y la entrada al destino.",
    );
  }

  return notas;
}

/**
 * Genera el reporte de movimientos en PDF.
 *
 * Devuelve el contenido y el nombre de archivo; el controller arma los headers.
 * Sin movimientos en el rango NO es un error: devuelve un PDF que lo dice. Un
 * reporte es un registro para archivar, y "en septiembre no hubo movimientos
 * de este producto" es un dato tan valido como cualquier otro. Un 404 ademas
 * seria falso —el producto o el proveedor existen— y obligaria al Frontend a
 * tratar como error un resultado normal.
 */
export async function generarReporteMovimientos(comercioId, query = {}) {
  const parametros = validarParametrosReporte(query);

  const [perfil, datosProducto, datosProveedor] = await Promise.all([
    obtenerPerfil(comercioId),
    parametros.productoId
      ? exigirProductoDelReporte(comercioId, parametros.productoId)
      : null,
    parametros.proveedorId
      ? exigirProveedorDelHistorial(comercioId, parametros.proveedorId)
      : null,
  ]);

  const movimientos = await leerMovimientos(comercioId, {
    ...parametros,
    // Ya validados contra el comercio: de aca en mas se filtra por el id que
    // devolvio la base, no por el crudo de la query.
    productoId: datosProducto?.id,
    proveedorId: datosProveedor?.id,
  });

  const { tipo, desde, hasta, zonaHoraria } = parametros;

  const filtros = [
    ["Tipo de reporte", NOMBRE_DEL_TIPO[tipo]],
    [
      "Rango aplicado",
      `${formatearFechaHora(desde, zonaHoraria)} al ${formatearFechaHora(hasta, zonaHoraria)} (hora de ${zonaHoraria})`,
    ],
  ];

  if (datosProducto) {
    filtros.push([
      "Producto",
      `${conBaja(datosProducto.nombre, datosProducto.activo)} — código ${datosProducto.codigoBarras}, en ${datosProducto.unidadMedida}`,
    ]);
  }
  if (datosProveedor) {
    filtros.push([
      "Proveedor",
      conBaja(datosProveedor.nombre, datosProveedor.activo),
    ]);
  }

  const contenido = await generarPdfTabular({
    comercio: perfil.nombre,
    titulo: TITULO_POR_TIPO[tipo],
    generadoEn: new Date(),
    zonaHoraria,
    filtros,
    columnas: columnasDelReporte(tipo, zonaHoraria),
    filas: movimientos,
    totales: totalesDelReporte(calcularTotales(movimientos)),
    notas: notasDelReporte(movimientos),
    mensajeVacio: "No se registraron movimientos en el rango seleccionado.",
  });

  return {
    nombreArchivo: nombreDeArchivo(
      parametros,
      datosProducto?.nombre ?? datosProveedor?.nombre,
    ),
    contenido,
  };
}
