import { parse } from "csv-parse/sync";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { ubicacion } from "../db/schema.js";
import { ErrorDeNegocio } from "../lib/errores.js";
import { crearProducto } from "./productos.service.js";

/**
 * Importacion del catalogo inicial desde un CSV (HU-7).
 *
 * Service satelite del modulo `productos`, igual que
 * `productosExternos.service.js`: no tiene routes ni controller propios, el
 * endpoint vive en `/api/productos/importar`.
 *
 * La logica de negocio por fila NO se reimplementa: cada fila valida se manda a
 * `crearProducto` (HU-9), que es quien inserta PRODUCTO, resuelve la ubicacion
 * y carga el stock inicial via `aplicarMovimiento`. Lo unico que agrega este
 * archivo es leer el CSV, convertir texto a los tipos que espera la validacion,
 * y armar el reporte de que entro y que no.
 *
 * Lo que define la historia es el manejo del error parcial: una fila con un
 * dato invalido se informa pero NO frena el archivo. Por eso cada fila va en su
 * propia transaccion —la que abre `crearProducto`— en vez de un lote con
 * savepoints: asi es imposible que el error de una fila alcance a las demas, ni
 * siquiera si el proceso se cae a mitad de camino, porque lo ya importado esta
 * commiteado.
 */

/**
 * Tope de filas de datos por archivo.
 *
 * Existe porque el modelo es una transaccion por fila: sin tope, un archivo de
 * 100.000 filas serian 100.000 idas y vueltas a Neon en una sola request, que
 * se corta por timeout dejando la importacion a la mitad y sin reporte. Para la
 * carga inicial de un comercio PyME 1000 sobra.
 */
const MAXIMO_FILAS = 1000;

/**
 * Nombres de columna aceptados para cada campo.
 *
 * La clave es el nombre del campo tal como lo espera el body de
 * `POST /api/productos`; los valores son los encabezados ya normalizados que se
 * mapean a el. La lista es generosa a proposito: el comercio llega con una
 * planilla que ya existe, y obligarlo a renombrar encabezados antes de importar
 * es exactamente la friccion que HU-7 viene a sacar.
 */
const ALIAS_POR_CAMPO = {
  nombre: ["nombre", "producto", "articulo"],
  // "codigo" a secas NO es alias de codigo_barras: en la planilla de un
  // comercio esa columna suele ser el codigo interno (SKU), y aceptarla
  // significaba guardar el SKU como codigo de barras sin que nadie se entere.
  // Una columna "codigo" queda como desconocida y se ignora, que es el
  // resultado correcto.
  codigoBarras: [
    "codigo_barras",
    "codigobarras",
    "codigo_de_barras",
    "cod_barras",
    "ean",
  ],
  categoria: ["categoria", "rubro"],
  unidadMedida: ["unidad_medida", "unidadmedida", "unidad_de_medida", "unidad"],
  umbralMinimo: [
    "umbral_minimo",
    "umbralminimo",
    "umbral",
    "stock_minimo",
    "minimo",
  ],
  stockActual: [
    "stock_actual",
    "stockactual",
    "stock",
    "cantidad",
    "existencia",
  ],
  ubicacion: ["ubicacion", "deposito", "sucursal"],
};

/** Indice inverso encabezado normalizado -> campo, armado una sola vez. */
const CAMPO_POR_ALIAS = new Map(
  Object.entries(ALIAS_POR_CAMPO).flatMap(([campo, alias]) =>
    alias.map((nombre) => [nombre, campo]),
  ),
);

/**
 * Columnas sin las cuales el archivo entero no tiene sentido.
 *
 * `umbralMinimo` y `stockActual` no estan: una celda vacia se toma como 0, que
 * es lo mismo que manda el formulario de alta de HU-9 por defecto. `ubicacion`
 * tampoco: sin ella aplica la resolucion por defecto de HU-9.
 */
const CAMPOS_OBLIGATORIOS = [
  "nombre",
  "codigoBarras",
  "categoria",
  "unidadMedida",
];

/** Como se nombra cada campo al reportarle al usuario un problema de columnas. */
const ENCABEZADO_CANONICO = {
  nombre: "nombre",
  codigoBarras: "codigo_barras",
  categoria: "categoria",
  unidadMedida: "unidad_medida",
  umbralMinimo: "umbral_minimo",
  stockActual: "stock_actual",
  ubicacion: "ubicacion",
};

/**
 * Deja un texto comparable: sin acentos, en minuscula y sin espacios de sobra.
 *
 * Se usa para dos cosas distintas que necesitan lo mismo: matchear encabezados
 * ("Código de Barras" -> "codigo_de_barras") y matchear nombres de ubicacion
 * ("Depósito" del CSV contra "deposito" de la base). Nadie escribe los acentos
 * igual dos veces, y fallar por eso seria incomprensible para el usuario.
 */
function normalizarTexto(valor) {
  // `\p{Diacritic}` en vez de un rango de combinantes escrito a mano: el rango
  // literal deja caracteres invisibles en el fuente, que cualquier editor o
  // merge puede comerse sin que se note hasta que "Depósito" deje de matchear.
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

/** Encabezado del CSV -> forma canonica: `Stock Actual` -> `stock_actual`. */
function normalizarEncabezado(valor) {
  return normalizarTexto(valor)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Elige el separador mirando la linea de encabezados.
 *
 * Excel en configuracion regional es-AR exporta con `;` (porque la coma es el
 * separador decimal), y ese es el archivo que el comercio va a subir de verdad.
 * Se cuenta sobre los encabezados y no sobre todo el texto para que una coma
 * dentro del nombre de un producto no incline la decision.
 */
function detectarDelimitador(texto) {
  const primeraLinea = texto.split(/\r?\n/, 1)[0] ?? "";
  const puntoYComa = (primeraLinea.match(/;/g) ?? []).length;
  const comas = (primeraLinea.match(/,/g) ?? []).length;

  return puntoYComa > comas ? ";" : ",";
}

/**
 * Convierte el texto de una celda numerica al `number` que espera
 * `validarDatosProducto`.
 *
 * Una celda vacia (o una columna ausente) vale 0. Cualquier cosa que no sea
 * una tira de digitos se devuelve **cruda**, sin convertir: asi la rechaza
 * `validarDatosProducto` con su propio mensaje, en vez de duplicar el texto del
 * error aca.
 *
 * Deliberadamente no se usa `Number(...)`: `validarDatosProducto` exige
 * `typeof valor === "number"` justamente para que `""`, `null` y `[]` no se
 * cuelen como 0 (ver el comentario de `esEnteroNoNegativo` en
 * productos.service.js). Coercionar aca desarmaria esa proteccion y haria que
 * un `"abc"` entrara como `NaN` y un `"1.5"` como 1.5 sin que nadie se entere.
 */
function aEnteroOCrudo(valor) {
  const texto = typeof valor === "string" ? valor.trim() : "";

  if (texto === "") {
    return 0;
  }

  return /^\d+$/.test(texto) ? Number(texto) : valor;
}

function aTexto(valor) {
  return typeof valor === "string" ? valor.trim() : "";
}

/**
 * Pasa una fila cruda del CSV a la forma del body de `POST /api/productos`.
 *
 * Es pura y no toca la base, para poder testearla sola (mismo criterio que
 * `validarDatosProducto`). No valida nada: de eso se encarga `crearProducto`,
 * que es lo que garantiza que la importacion aplique exactamente las mismas
 * reglas que el alta individual.
 *
 * `ubicacionNombre` sale aparte del resto porque no es un campo del producto:
 * se resuelve a un `ubicacionId` antes de llamar al alta.
 */
export function normalizarFilaCsv(filaCruda = {}) {
  return {
    nombre: aTexto(filaCruda.nombre),
    codigoBarras: aTexto(filaCruda.codigoBarras),
    categoria: aTexto(filaCruda.categoria),
    unidadMedida: aTexto(filaCruda.unidadMedida),
    umbralMinimo: aEnteroOCrudo(filaCruda.umbralMinimo),
    stockActual: aEnteroOCrudo(filaCruda.stockActual),
    ubicacionNombre: aTexto(filaCruda.ubicacion),
  };
}

/**
 * Lee el CSV entero y devuelve sus filas con el numero de linea del archivo.
 *
 * Lanza 400 solo por problemas del archivo completo (vacio, ilegible, sin una
 * columna obligatoria, demasiado grande). Un dato malo en una celda no se mira
 * aca: eso es un error de fila y se reporta sin frenar la importacion.
 *
 * `fila` es el numero de linea del archivo donde TERMINA el registro, que para
 * una fila normal de una sola linea es su linea. Se usa ese y no el indice del
 * array porque es el numero que el usuario ve al abrir el CSV en Excel: un
 * "error en la fila 3" que no coincide con la fila 3 de la planilla es peor que
 * no decir nada.
 */
export function parsearCatalogoCsv(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new ErrorDeNegocio("No se recibió ningún archivo CSV", 400);
  }

  const texto = buffer.toString("utf8");

  if (texto.trim() === "") {
    throw new ErrorDeNegocio("El archivo CSV está vacío", 400);
  }

  // Encabezado canonico -> el texto tal cual venia en el archivo, para poder
  // nombrar las dos columnas si dos se reclaman el mismo campo.
  const camposPresentes = new Map();
  const ambiguas = [];
  let registros;

  try {
    registros = parse(texto, {
      delimiter: detectarDelimitador(texto),
      // El BOM (U+FEFF) lo antepone Excel al guardar como "CSV UTF-8". Sin
      // esta opcion se pega al primer encabezado, que deja de matchear con
      // nada, y el archivo se rechaza por "falta la columna nombre" aunque
      // este ahi: el caracter es invisible y el error es indescifrable.
      bom: true,
      skip_empty_lines: true,
      trim: true,
      // Una fila con menos (o mas) celdas que encabezados no rompe el archivo:
      // se lee lo que haya y los campos que falten quedan vacios, con lo cual
      // la fila cae como error de fila y las demas siguen.
      relax_column_count: true,
      // Una comilla suelta en medio de un campo sin entrecomillar (`TV 32" LED`,
      // `Caño 1/2"`) es corriente en el catalogo de una ferreteria o una casa
      // de electrodomesticos. En modo estricto csv-parse la trata como
      // INVALID_OPENING_QUOTE y tira el ARCHIVO ENTERO con 400, que es
      // exactamente lo que HU-7 promete que no pasa. Con esto la comilla se
      // toma como un caracter mas del texto. Los campos entrecomillados de
      // verdad y las comillas escapadas ("") siguen funcionando igual, y un
      // archivo genuinamente roto (comilla sin cerrar) se sigue rechazando.
      relax_quotes: true,
      info: true,
      columns: (encabezados) =>
        encabezados.map((encabezado, indice) => {
          const campo = CAMPO_POR_ALIAS.get(normalizarEncabezado(encabezado));

          if (!campo) {
            // Columna desconocida (precio, proveedor, lo que traiga el export
            // de otro sistema): se conserva con un nombre inventado unico para
            // que no pise ningun campo real, y despues se ignora. Rechazar el
            // archivo por traer columnas de mas seria hostil.
            return `__ignorada_${indice}`;
          }

          // Dos encabezados que se reclaman el mismo campo se anotan como
          // ambiguos en vez de dejar que gane el ultimo: con `columns`, el
          // segundo pisa al primero en silencio, y el comercio termina con
          // datos mal cargados sin un solo error a la vista. Es preferible
          // frenar el archivo y que decida cual columna vale.
          const previo = camposPresentes.get(campo);

          if (previo !== undefined) {
            ambiguas.push({ campo, columnas: [previo, encabezado] });
            return `__ignorada_${indice}`;
          }

          camposPresentes.set(campo, encabezado);
          return campo;
        }),
    });
  } catch (error) {
    throw new ErrorDeNegocio(
      `El archivo no se pudo leer como CSV: ${error.message}`,
      400,
    );
  }

  if (ambiguas.length > 0) {
    const detalle = ambiguas
      .map(
        ({ campo, columnas }) =>
          `"${columnas[0]}" y "${columnas[1]}" apuntan a ${ENCABEZADO_CANONICO[campo] ?? campo}`,
      )
      .join("; ");

    throw new ErrorDeNegocio(
      `El archivo tiene columnas ambiguas: ${detalle}. Dejá una sola de cada una.`,
      400,
    );
  }

  const faltantes = CAMPOS_OBLIGATORIOS.filter(
    (campo) => !camposPresentes.has(campo),
  );

  if (faltantes.length > 0) {
    throw new ErrorDeNegocio(
      `Al archivo le faltan columnas obligatorias: ${faltantes
        .map((campo) => ENCABEZADO_CANONICO[campo])
        .join(", ")}`,
      400,
    );
  }

  // Filas fantasma: `skip_empty_lines` descarta la linea totalmente vacia,
  // pero no la que trae solo separadores (`,,,`). Excel las genera de a
  // decenas cuando alguien le dio formato a celdas mas abajo de los datos, y
  // sin este filtro cada una se reporta como "fila con error" —un catalogo de
  // 3 productos devolviendo `fallidos: 40` no se entiende— ademas de consumir
  // el presupuesto de MAXIMO_FILAS. Se descartan en silencio, que es lo que
  // significan: no son un producto mal cargado, no son nada.
  const conDatos = registros.filter(({ record }) =>
    Object.entries(record).some(
      ([clave, valor]) =>
        !clave.startsWith("__ignorada_") && aTexto(valor) !== "",
    ),
  );

  if (conDatos.length === 0) {
    throw new ErrorDeNegocio(
      "El archivo no tiene ninguna fila de datos debajo de los encabezados",
      400,
    );
  }

  if (conDatos.length > MAXIMO_FILAS) {
    throw new ErrorDeNegocio(
      `El archivo tiene ${conDatos.length} filas y el máximo es ${MAXIMO_FILAS}`,
      400,
    );
  }

  return conDatos.map(({ record, info }) => ({
    fila: info.lines,
    datos: record,
  }));
}

/**
 * Trae las ubicaciones del comercio en un indice de dos niveles.
 *
 * Una sola query antes del loop en vez de una por fila: el CSV de un comercio
 * repite las mismas dos o tres ubicaciones en cientos de filas.
 *
 * Son DOS indices y no uno solo por normalizado, y esa es la parte que importa:
 * el unique de la base (`ubicacion_comercioId_nombre_uidx`) es por nombre
 * exacto, asi que un comercio puede tener "Depósito" y "Deposito" como dos
 * ubicaciones distintas y legitimas. Con un unico mapa normalizado las dos
 * colapsan en la misma clave y gana la que el SELECT devuelva ultima —sin
 * ORDER BY, la que Postgres quiera ese dia—, con lo cual el stock del CSV
 * podria terminar en la ubicacion equivocada. Aca el nombre exacto manda, y el
 * match sin acentos solo se usa cuando no es ambiguo.
 */
async function cargarIndiceDeUbicaciones(comercioId) {
  const filas = await db
    .select({ id: ubicacion.id, nombre: ubicacion.nombre })
    .from(ubicacion)
    .where(eq(ubicacion.comercioId, comercioId))
    .orderBy(asc(ubicacion.nombre));

  const exacto = new Map();
  // normalizado -> lista de ids, para poder detectar la ambiguedad.
  const porNormalizado = new Map();

  for (const fila of filas) {
    exacto.set(fila.nombre.trim(), fila.id);

    const clave = normalizarTexto(fila.nombre);
    porNormalizado.set(clave, [...(porNormalizado.get(clave) ?? []), fila.id]);
  }

  return { exacto, porNormalizado };
}

/**
 * Resuelve el nombre de ubicacion de una fila a un id.
 *
 * Sin nombre devuelve `undefined`, que es lo que hace que `crearProducto`
 * aplique la resolucion por defecto de HU-9 (primera ubicacion del comercio, o
 * crear "Principal" si todavia no tiene ninguna).
 *
 * Ante un nombre desconocido re-consulta la base **una sola vez por
 * importacion**, no una vez por fila: si la primera fila no traia ubicacion,
 * HU-9 pudo haber creado "Principal" recien ahi, despues de armado el indice, y
 * sin esa segunda chance una fila posterior que la nombre seria rechazada por
 * una ubicacion que si existe. Pero repetir la consulta en cada fallo hacia que
 * un archivo de 1000 filas con la ubicacion mal escrita costara 1000 queries de
 * mas encima de las 1000 transacciones — justo la explosion de round-trips que
 * MAXIMO_FILAS existe para evitar.
 */
async function resolverUbicacionPorNombre(comercioId, indice, nombreCrudo) {
  if (!nombreCrudo) {
    return undefined;
  }

  const buscar = () => {
    const exacta = indice.exacto.get(nombreCrudo);

    if (exacta) {
      return exacta;
    }

    const candidatas = indice.porNormalizado.get(normalizarTexto(nombreCrudo));

    if (candidatas?.length === 1) {
      return candidatas[0];
    }

    if (candidatas?.length > 1) {
      // El comercio tiene dos ubicaciones que solo se diferencian por acentos o
      // mayusculas. Adivinar cual quiso decir seria mandar mercaderia al lugar
      // equivocado en silencio.
      throw new ErrorDeNegocio(
        `La ubicación "${nombreCrudo}" es ambigua: el comercio tiene más de una con ese nombre. Escribila igual que en la configuración de ubicaciones.`,
        400,
      );
    }

    return undefined;
  };

  const encontrada = buscar();

  if (encontrada) {
    return encontrada;
  }

  if (!indice.refrescado) {
    const fresco = await cargarIndiceDeUbicaciones(comercioId);
    indice.exacto = fresco.exacto;
    indice.porNormalizado = fresco.porNormalizado;
    indice.refrescado = true;

    const reintento = buscar();

    if (reintento) {
      return reintento;
    }
  }

  throw new ErrorDeNegocio(
    `La ubicación "${nombreCrudo}" no existe en el comercio`,
    400,
  );
}

/**
 * Importa el catalogo del CSV, fila por fila (HU-7).
 *
 * Cada fila valida se crea con `crearProducto`, que abre su propia transaccion:
 * lo importado queda commiteado aunque la fila siguiente falle. Las filas se
 * recorren **en serie** a proposito, no con `Promise.all`: en paralelo se
 * multiplicaria la carrera que `resolverUbicacionParaAlta` ya tiene que cuidar
 * al crear la ubicacion "Principal", se agotaria el pool de conexiones, y el
 * reporte perderia el orden del archivo.
 *
 * Solo un `ErrorDeNegocio` de menos de 500 se anota como fila con error.
 * Cualquier otra cosa (un bug, la base caida) NO se degrada a fila con error:
 * decirle al comerciante "esta fila tiene un dato invalido" cuando en realidad
 * se cayo la conexion seria mentirle, y lo mandaria a "corregir" un archivo que
 * estaba bien.
 *
 * Lo que se hace en ese caso es **cortar el loop y devolver igual el reporte de
 * lo que se alcanzo a hacer**, marcado con `interrumpido`. La razon es que las
 * filas anteriores ya estan commiteadas —cada una fue en su propia
 * transaccion, que es justo lo que hace que una fila mala no arrastre a las
 * buenas— y un 500 pelado no las deshace: solo se las oculta al usuario, que
 * queda sin saber que 200 de sus 500 productos entraron.
 *
 * La excepcion es que no haya entrado nada: ahi no hay ningun cambio que
 * reportar, un 200 diciendo "importe 0" seria absurdo, y ademas conviene que el
 * monitoreo vea el 500. En ese caso se relanza, como antes.
 */
export async function importarProductos(comercioId, usuarioId, buffer) {
  const filas = parsearCatalogoCsv(buffer);
  const indiceUbicaciones = {
    ...(await cargarIndiceDeUbicaciones(comercioId)),
    refrescado: false,
  };

  const productos = [];
  const errores = [];
  // codigo de barras -> numero de fila donde ya vino, para poder decir en cual.
  const codigosDelArchivo = new Map();

  let procesadas = 0;
  let interrupcion = null;

  for (const { fila, datos } of filas) {
    procesadas += 1;
    const { ubicacionNombre, ...producto } = normalizarFilaCsv(datos);

    try {
      // El indice unico parcial de la base es el guardian real del duplicado
      // (y el unico que ve los productos ya cargados de antes). Este chequeo
      // existe solo para el mensaje: "repetido, ya venia en la fila 12" es
      // accionable, "ya existe un producto con ese codigo" sobre un catalogo
      // que todavia no existia no lo es.
      const filaPrevia = codigosDelArchivo.get(producto.codigoBarras);

      if (producto.codigoBarras && filaPrevia) {
        throw new ErrorDeNegocio(
          `El código de barras "${producto.codigoBarras}" está repetido en el archivo: ya venía en la fila ${filaPrevia}`,
          409,
        );
      }

      const ubicacionId = await resolverUbicacionPorNombre(
        comercioId,
        indiceUbicaciones,
        ubicacionNombre,
      );

      const creado = await crearProducto(comercioId, usuarioId, {
        ...producto,
        ubicacionId,
      });

      codigosDelArchivo.set(creado.codigoBarras, fila);
      productos.push({
        fila,
        id: creado.id,
        nombre: creado.nombre,
        codigoBarras: creado.codigoBarras,
      });
    } catch (error) {
      if (!(error instanceof ErrorDeNegocio) || error.status >= 500) {
        // Se loguea entero SIEMPRE, porque este error ya no va a llegar al
        // manejador de `app.js` que loguea los 500. Sin esto, un bug propio
        // pasaria a devolver 200 y desapareceria del radar.
        console.error(
          `[importacion] corte en la fila ${fila} (comercio ${comercioId})`,
          error,
        );

        // Nada commiteado todavia: no hay reporte parcial que dar, y el 500 es
        // la respuesta honesta (ademas de la que ve el monitoreo).
        if (productos.length === 0) {
          throw error;
        }

        procesadas -= 1;
        interrupcion = {
          fila,
          motivo:
            "La importación se cortó por un problema del sistema. Los productos ya importados quedaron guardados: volvé a subir el mismo archivo para continuar desde donde se cortó.",
        };
        break;
      }

      errores.push({
        fila,
        codigoBarras: producto.codigoBarras,
        motivo: error.message,
      });
    }
  }

  return {
    totalFilas: filas.length,
    // Cuantas se llegaron a intentar. Con `interrumpido` en false es igual a
    // `totalFilas`; el invariante que vale siempre es
    // `importados + fallidos === procesadas`.
    procesadas,
    importados: productos.length,
    fallidos: errores.length,
    productos,
    errores,
    interrumpido: interrupcion !== null,
    // La fila del corte NO va en `errores`: ahi cada entrada significa "este
    // dato hay que corregirlo", y esta fila no tiene nada malo, simplemente no
    // se llego a procesar.
    interrupcion,
  };
}
