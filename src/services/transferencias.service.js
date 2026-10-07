import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { stock, transferencia } from "../db/schema.js";
import { ErrorDeNegocio, esUuid } from "../lib/errores.js";
import {
  aplicarMovimiento,
  CANTIDAD_MAXIMA,
  exigirProductoDelComercio,
  MOTIVO_MAXIMO,
  resolverUbicacion,
} from "./movimientos.service.js";

/**
 * Logica de negocio de la transferencia de stock entre ubicaciones (HU-12).
 *
 * Una transferencia no es un tipo nuevo de operacion sobre el stock: son dos
 * movimientos de los de siempre —uno negativo en el origen, uno positivo en el
 * destino— ligados por `transferencia_id` y aplicados en la misma transaccion.
 * Por eso este modulo no reimplementa nada del libro: compone las piezas de
 * HU-13 (`exigirProductoDelComercio`, `resolverUbicacion`, `aplicarMovimiento`)
 * y solo agrega lo que es propio de mover mercaderia entre dos lugares: el
 * encabezado, la validacion de origen != destino y el orden en que se toman
 * los bloqueos.
 *
 * Como en el resto del repo, `comercioId` y `usuarioId` vienen primero y salen
 * siempre de la sesion, nunca del body.
 */

/**
 * Valida y normaliza el body de una transferencia.
 *
 * Pura y sin base, para testearla sola (igual que `validarDatosMovimiento`).
 * Devuelve un objeto nuevo con solo los campos conocidos: un `comercioId` o un
 * `usuarioId` que venga en el body se pierde aca.
 *
 * `cantidad` se recibe y se devuelve como magnitud positiva: el signo de cada
 * pata lo pone `transferirStock`, que es quien sabe cual es el origen y cual
 * el destino.
 */
export function validarDatosTransferencia(datosCrudos = {}) {
  if (!esUuid(datosCrudos.productoId)) {
    throw new ErrorDeNegocio("El producto indicado no es válido", 400);
  }

  const origenCrudo = datosCrudos.ubicacionOrigenId;
  const destinoCrudo = datosCrudos.ubicacionDestinoId;

  // Las dos son obligatorias: a diferencia de HU-13, aca no hay nada que
  // inferir. Un comercio con una sola ubicacion no tiene a donde transferir, y
  // adivinar el destino seria decidir por el usuario donde quedo la
  // mercaderia.
  if (!origenCrudo || !destinoCrudo) {
    throw new ErrorDeNegocio(
      "Se requieren la ubicación de origen y la de destino",
      400,
    );
  }

  // 404 y no 400, mismo criterio que `validarDatosMovimiento`: para este
  // comercio esa ubicacion no existe, que es el mismo resultado que si el UUID
  // fuera valido pero de otro comercio.
  if (!esUuid(origenCrudo) || !esUuid(destinoCrudo)) {
    throw new ErrorDeNegocio("La ubicación no existe", 404);
  }

  // En minuscula antes de comparar: `esUuid` acepta mayusculas y Postgres no
  // las distingue, asi que 'AAAA...' y 'aaaa...' son la misma ubicacion.
  // Comparados tal como llegan, el `===` los veria distintos, la validacion
  // pasaria, y el CHECK de la tabla cortaria el INSERT con un 500.
  const origen = origenCrudo.toLowerCase();
  const destino = destinoCrudo.toLowerCase();

  if (origen === destino) {
    throw new ErrorDeNegocio(
      "La ubicación de origen y la de destino deben ser distintas",
      400,
    );
  }

  // Mismos criterios que `validarDatosMovimiento`, a proposito: una
  // transferencia no puede aceptar una cantidad que una venta rechaza. En
  // particular `typeof number` y no `Number(...)`, porque la coercion
  // convierte `true` en 1, y el tope de arriba porque `movimiento.cantidad` es
  // un integer de Postgres y un valor mas grande saldria como 500.
  //
  // Nota heredada: la unidad de medida del producto no se mira: `kg` y `l`
  // tampoco admiten decimales en HU-13, y divergir aca haria que transferir
  // acepte lo que vender rechaza.
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

  // Opcional, a diferencia del ajuste y la merma (HU-15): el par ligado ya
  // explica que paso. Se recorta antes de medirlo, porque "   " es una cadena
  // no vacia para JavaScript pero no es un motivo.
  const motivoCrudo =
    typeof datosCrudos.motivo === "string" ? datosCrudos.motivo.trim() : "";

  if (motivoCrudo.length > MOTIVO_MAXIMO) {
    throw new ErrorDeNegocio(
      `El motivo no puede superar los ${MOTIVO_MAXIMO} caracteres`,
      400,
    );
  }

  return {
    // Tambien en minuscula, por consistencia: asi todo lo que sale de aca
    // tiene la misma forma que los ids que devuelve la base.
    productoId: datosCrudos.productoId.toLowerCase(),
    ubicacionOrigenId: origen,
    ubicacionDestinoId: destino,
    cantidad,
    motivo: motivoCrudo === "" ? null : motivoCrudo,
  };
}

/**
 * Bloquea las filas de stock de las dos ubicaciones, en un orden fijo.
 *
 * `aplicarMovimiento` ya hace su propio SELECT ... FOR UPDATE, y eso alcanza
 * para que dos transferencias del mismo producto desde la misma ubicacion se
 * serialicen y ninguna deje el stock en negativo. Lo que no alcanza es para el
 * deadlock: una transferencia A -> B y otra B -> A, simultaneas, tomarian los
 * dos bloqueos en orden inverso, y Postgres abortaria una con 40P01, que sale
 * como 500 y no como un error que el usuario pueda entender.
 *
 * Tomar los dos de una, ordenados por `ubicacion_id`, da un orden global igual
 * para toda transferencia y en cualquier sentido. Postgres bloquea las filas
 * en el orden en que el plan las devuelve (el bloqueo va arriba del ORDER BY),
 * asi que en la practica esa espera circular no se forma — lo cubre el test de
 * transferencias en sentidos opuestos. No es una garantia documentada como
 * inmutable: si algun dia aparece un 40P01, el lugar para mirar es este. Los
 * FOR UPDATE que vienen despues piden bloqueos que esta transaccion ya tiene:
 * no esperan a nadie.
 *
 * Limite heredado de HU-13: si la fila del destino todavia no existe, no hay
 * nada que bloquear (Postgres no tiene gap lock para esto). La creacion
 * concurrente la serializa igual el ON CONFLICT DO UPDATE del upsert, que suma
 * en SQL y no con un valor leido antes.
 */
async function bloquearFilasDeStock(tx, comercioId, productoId, ubicaciones) {
  await tx
    .select({ id: stock.id })
    .from(stock)
    .where(
      and(
        eq(stock.comercioId, comercioId),
        eq(stock.productoId, productoId),
        inArray(stock.ubicacionId, ubicaciones),
      ),
    )
    .orderBy(asc(stock.ubicacionId))
    .for("update");
}

/**
 * Transfiere unidades de un producto de una ubicacion a otra (HU-12).
 *
 * Todo pasa dentro de una unica transaccion: el encabezado, las dos filas del
 * libro y las dos filas de stock. Si algo falla —tipicamente, que el origen no
 * tenga suficiente— no queda ni la transferencia, ni un movimiento suelto, ni
 * un saldo tocado.
 *
 * El orden importa: la pata negativa va primero, asi el rechazo por stock
 * insuficiente ocurre antes de escribir nada en el destino.
 */
export async function transferirStock(comercioId, usuarioId, datosCrudos = {}) {
  const datos = validarDatosTransferencia(datosCrudos);

  return db.transaction(async (tx) => {
    const productoId = await exigirProductoDelComercio(
      tx,
      comercioId,
      datos.productoId,
    );

    const ubicacionOrigenId = await resolverUbicacion(
      tx,
      comercioId,
      datos.ubicacionOrigenId,
    );
    const ubicacionDestinoId = await resolverUbicacion(
      tx,
      comercioId,
      datos.ubicacionDestinoId,
    );

    await bloquearFilasDeStock(tx, comercioId, productoId, [
      ubicacionOrigenId,
      ubicacionDestinoId,
    ]);

    const [cabecera] = await tx
      .insert(transferencia)
      .values({
        comercioId,
        ubicacionOrigenId,
        ubicacionDestinoId,
        usuarioId,
        motivo: datos.motivo,
      })
      .returning();

    // `proveedorId` no se pasa en ninguna de las dos patas: una transferencia
    // es un movimiento interno, no hay contraparte externa a quien atribuirle
    // la mercaderia. `aplicarMovimiento` lo deja en null solo.
    const salida = await aplicarMovimiento(tx, {
      comercioId,
      productoId,
      ubicacionId: ubicacionOrigenId,
      usuarioId,
      tipo: "transferencia",
      cantidad: -datos.cantidad,
      motivo: datos.motivo,
      transferenciaId: cabecera.id,
    });

    const entrada = await aplicarMovimiento(tx, {
      comercioId,
      productoId,
      ubicacionId: ubicacionDestinoId,
      usuarioId,
      tipo: "transferencia",
      cantidad: datos.cantidad,
      motivo: datos.motivo,
      transferenciaId: cabecera.id,
    });

    return {
      transferencia: cabecera,
      // Salida primero y entrada despues, el mismo orden en que ocurrieron.
      movimientos: [salida.movimiento, entrada.movimiento],
      // Los dos saldos nuevos, para que la pantalla se refresque sin otro GET.
      stock: { origen: salida.stock, destino: entrada.stock },
    };
  });
}
