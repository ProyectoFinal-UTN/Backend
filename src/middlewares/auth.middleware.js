import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import { roles } from "../lib/permissions.js";
import { obtenerContextoDeComercio } from "../services/sesion.service.js";

/**
 * Valida la sesion con Better Auth y arma el contexto de tenant.
 *
 * Deja disponible en `req`:
 *   req.usuario    -> el usuario logueado
 *   req.sesion     -> la sesion de Better Auth
 *   req.rol        -> propietario | gerente | empleado
 *   req.comercioId -> el tenant, para filtrar TODA query de negocio
 *
 * `req.comercioId` sale siempre de la sesion, nunca del body ni de la query
 * string: un cliente no puede elegir sobre que comercio opera.
 */
export async function requireAuth(req, res, next) {
  try {
    const sesion = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!sesion) {
      return res.status(401).json({ error: "No hay sesion activa" });
    }

    const contexto = await obtenerContextoDeComercio({
      userId: sesion.user.id,
      email: sesion.user.email,
      organizationId: sesion.session.activeOrganizationId,
    });

    if (!contexto) {
      return res
        .status(403)
        .json({ error: "El usuario no tiene un comercio asociado" });
    }

    req.usuario = sesion.user;
    req.sesion = sesion.session;
    req.rol = contexto.rol;
    req.comercioId = contexto.comercioId;
    req.organizationId = contexto.organizationId;

    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Unico mensaje de "no te toca" de la API (HU-32). Lo usan `requireRole`,
 * `requirePermission` y el cierre de los endpoints de organizacion: el front
 * tiene un solo formato de 403 por rol que reconocer.
 */
export const SIN_PERMISO = "El rol no tiene permiso para esta accion";

/**
 * Restringe una ruta a uno o mas roles.
 *
 *   router.get("/auditoria", requireAuth, requireRole("propietario"), ctrl.listar)
 *
 * Se usa siempre como middleware. La regla del equipo es que el rol nunca se
 * valida con un `if` suelto adentro de un controller.
 */
export function requireRole(...rolesPermitidos) {
  return function verificarRol(req, res, next) {
    if (!req.rol) {
      return res.status(401).json({ error: "No hay sesion activa" });
    }

    if (!rolesPermitidos.includes(req.rol)) {
      return res.status(403).json({ error: SIN_PERMISO });
    }

    return next();
  };
}

/**
 * Restringe una ruta por permiso concreto en vez de por nombre de rol.
 *
 *   router.delete("/:id", requireAuth, requirePermission({ producto: ["delete"] }), ctrl.eliminar)
 *
 * Preferible a `requireRole` cuando lo que importa es la accion y no quien la
 * hace: si manana cambia que rol puede borrar productos, se toca solo la matriz
 * de src/lib/permissions.js y ninguna ruta se entera.
 */
export function requirePermission(permisos) {
  return function verificarPermiso(req, res, next) {
    // Sin rol en la request no hubo sesion: eso si es un 401.
    if (!req.rol) {
      return res.status(401).json({ error: "No hay sesion activa" });
    }

    const rol = roles[req.rol];

    // Con rol pero desconocido (un typo en un seed, un rol renombrado) la
    // sesion existe, asi que el 401 mentiria: el front lo leeria como sesion
    // vencida, desloguearia, el login funcionaria, y volveria a fallar en un
    // loop. Es un 403.
    if (!rol) {
      return res
        .status(403)
        .json({ error: "El rol del usuario no es valido" });
    }

    if (!rol.authorize(permisos).success) {
      return res.status(403).json({ error: SIN_PERMISO });
    }

    return next();
  };
}

/**
 * Cierra los endpoints del plugin de organizacion de Better Auth
 * (`/api/auth/organization/*`).
 *
 * El plugin los publica solo por estar configurado, y no pasan por
 * `requirePermission`. Varios solo verifican que el usuario sea miembro:
 * `list-members`, `get-full-organization` y `list-invitations` le mostraban
 * a un empleado la lista del equipo con correos, que `GET /api/miembros` le
 * niega (HU-4). Los que si chequean rol lo hacen con la matriz heredada del
 * plugin, y ademas saltean los flujos propios de HU-4.
 *
 * Nadie los necesita por HTTP: el Frontend solo usa login, registro, logout y
 * recuperacion, y el equipo se administra por `/api/miembros`. El backend los
 * sigue pudiendo usar en proceso con `auth.api.*`, que no pasa por aca.
 *
 * Se monta en `/api/auth`, pero compara contra la URL COMPLETA
 * (`req.originalUrl`) resuelta igual que la resuelve Better Auth, con
 * `new URL`. No alcanza con `req.path`: es relativo al montaje, y
 * `/api/auth/../auth/organization/...` le llega como `/../auth/organization`,
 * que no empieza con `organization`, mientras Better Auth resuelve la URL
 * entera y sirve el endpoint igual. Tampoco `//`, `%2F`, `%2e%2e` ni las
 * mayusculas tienen que poder esquivarlo.
 */
export function bloquearOrganizacionDirecta(req, res, next) {
  let segmentos;

  try {
    const [camino] = req.originalUrl.split("?");
    const decodificado = decodeURIComponent(camino).replace(/\\/g, "/");
    // Concatenado y no como URL relativa: un path que empieza con `//` se
    // leeria como un host.
    segmentos = new URL(`http://x${decodificado}`).pathname
      .toLowerCase()
      .split("/")
      .filter(Boolean);
  } catch {
    // Un escape roto no es un pedido legitimo a ningun endpoint.
    return res.status(400).json({ error: "Ruta invalida" });
  }

  const [api, base, recurso] = segmentos;

  if (api === "api" && base === "auth" && recurso === "organization") {
    return res.status(403).json({ error: SIN_PERMISO });
  }

  return next();
}
