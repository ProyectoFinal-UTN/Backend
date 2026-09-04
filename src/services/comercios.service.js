import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { comercio, member, organization } from "../db/schema.js";
import { ErrorDeNegocio } from "../lib/errores.js";
import { ROLES } from "../lib/permissions.js";

/** Nombre con el que nace el comercio hasta que HU-6 carga el perfil real. */
export const NOMBRE_COMERCIO_POR_DEFECTO = "Mi comercio";

/**
 * Convierte un texto en un slug apto para `organization.slug`.
 * Sin tildes, sin espacios, solo minusculas, numeros y guiones.
 */
export function generarSlug(texto) {
  const base = texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");

  // El sufijo evita colisiones entre dos comercios con el mismo nombre:
  // `organization.slug` es unique y un choque abortaria el registro.
  return `${base || "comercio"}-${randomUUID().slice(0, 8)}`;
}

/**
 * Da de alta el comercio de un usuario recien registrado (HU-1).
 *
 * Crea las tres filas que convierten a un usuario suelto en propietario de un
 * comercio, dentro de una unica transaccion:
 *
 *   organization  ->  el tenant que gestiona Better Auth
 *   member        ->  la membresia, con rol `propietario` (RF9)
 *   comercio      ->  los datos del negocio, 1:1 con organization
 *
 * Va en transaccion porque las tres son inseparables: un usuario con
 * organization pero sin comercio no pasa `requireAuth`, y uno sin member no
 * tiene rol. Si falla cualquiera, no queda ninguna a medias.
 *
 * El nombre del comercio queda en un placeholder a proposito: el formulario de
 * registro solo pide correo y contrasena, y el perfil real se carga en HU-6.
 */
export async function crearComercioParaPropietario({ userId, email }) {
  const nombreOrganizacion = email?.split("@")[0] || "comercio";

  return db.transaction(async (tx) => {
    const organizationId = randomUUID();
    const ahora = new Date();

    await tx.insert(organization).values({
      id: organizationId,
      name: nombreOrganizacion,
      slug: generarSlug(nombreOrganizacion),
      createdAt: ahora,
    });

    await tx.insert(member).values({
      id: randomUUID(),
      organizationId,
      userId,
      role: ROLES.PROPIETARIO,
      createdAt: ahora,
    });

    const [comercioCreado] = await tx
      .insert(comercio)
      .values({
        organizationId,
        nombre: NOMBRE_COMERCIO_POR_DEFECTO,
      })
      .returning({ id: comercio.id });

    return { organizationId, comercioId: comercioCreado.id };
  });
}

/**
 * Devuelve el comercio de una organizacion, o null si no existe.
 */
export async function obtenerComercioPorOrganizacion(organizationId) {
  const [fila] = await db
    .select()
    .from(comercio)
    .where(eq(comercio.organizationId, organizationId))
    .limit(1);

  return fila ?? null;
}

/* ---------------------------------------------------------------------------
 * Perfil del comercio (HU-6)
 * ------------------------------------------------------------------------- */

/** Lo que la pantalla puede leer y escribir del perfil. */
const CAMPOS_PERFIL = {
  nombre: comercio.nombre,
  rubro: comercio.rubro,
  direccion: comercio.direccion,
  telefono: comercio.telefono,
  correoContacto: comercio.correoContacto,
};

/**
 * Reglas de cada campo del perfil.
 *
 * `nombre` y `rubro` son obligatorios: sin ellos el comercio queda con el
 * placeholder que le puso el registro y el sistema no sirve para nada. Los
 * datos de contacto son opcionales, porque un comercio chico puede no querer
 * cargarlos, pero si los carga tienen que ser validos.
 */
const REGLAS = {
  nombre: { etiqueta: "nombre", obligatorio: true, largo: 150 },
  rubro: { etiqueta: "rubro", obligatorio: true, largo: 100 },
  direccion: { etiqueta: "dirección", obligatorio: false, largo: 255 },
  telefono: { etiqueta: "teléfono", obligatorio: false, largo: 40 },
  correoContacto: {
    etiqueta: "correo de contacto",
    obligatorio: false,
    largo: 255,
  },
};

const FORMATO_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Valida y normaliza el perfil que llega del cliente.
 *
 * Devuelve solo los campos conocidos: si el body trae `moneda` o `id`, se
 * ignoran. La moneda se cambia por su propio endpoint (HU-8) y el id no se
 * toca nunca.
 */
function validarPerfil(datos) {
  const limpio = {};

  for (const [campo, regla] of Object.entries(REGLAS)) {
    const crudo = datos?.[campo];
    const valor = typeof crudo === "string" ? crudo.trim() : "";

    if (!valor) {
      if (regla.obligatorio) {
        throw new ErrorDeNegocio(`El ${regla.etiqueta} es obligatorio`, 400);
      }

      // Un opcional vacio se guarda como null y no como cadena vacia, para
      // que "sin cargar" se distinga de "cargado en blanco".
      limpio[campo] = null;
      continue;
    }

    if (valor.length > regla.largo) {
      throw new ErrorDeNegocio(
        `El ${regla.etiqueta} no puede superar los ${regla.largo} caracteres`,
        400,
      );
    }

    limpio[campo] = valor;
  }

  if (limpio.correoContacto && !FORMATO_CORREO.test(limpio.correoContacto)) {
    throw new ErrorDeNegocio("El correo de contacto no es válido", 400);
  }

  return limpio;
}

/** Devuelve el perfil del comercio de la sesion (HU-6). */
export async function obtenerPerfil(comercioId) {
  const [perfil] = await db
    .select(CAMPOS_PERFIL)
    .from(comercio)
    .where(eq(comercio.id, comercioId))
    .limit(1);

  if (!perfil) {
    throw new ErrorDeNegocio("El comercio no existe", 404);
  }

  return perfil;
}

/** Guarda los datos del negocio (HU-6). */
export async function actualizarPerfil(comercioId, datos) {
  const perfil = validarPerfil(datos);

  const [actualizado] = await db
    .update(comercio)
    .set(perfil)
    .where(eq(comercio.id, comercioId))
    .returning(CAMPOS_PERFIL);

  if (!actualizado) {
    throw new ErrorDeNegocio("El comercio no existe", 404);
  }

  return actualizado;
}
