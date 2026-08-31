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
      return res
        .status(403)
        .json({ error: "El rol no tiene acceso a este recurso" });
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
      return res
        .status(403)
        .json({ error: "El rol no tiene permiso para esta accion" });
    }

    return next();
  };
}
