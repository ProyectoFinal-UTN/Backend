import {
  aceptarInvitacion,
  cambiarRol,
  cancelarInvitacion,
  invitar,
  listarInvitacionesPendientes,
  listarMiembros,
  quitarMiembro,
  rolesAsignables,
  verInvitacion,
} from "../services/miembros.service.js";

/**
 * Controllers de la gestion del equipo (HU-4).
 *
 * Solo traducen HTTP. El `organizationId` y el `usuario` salen de `req`, donde
 * los dejo `requireAuth` a partir de la sesion.
 */

export async function listar(req, res, next) {
  try {
    const [miembros, invitaciones] = await Promise.all([
      listarMiembros(req.organizationId),
      listarInvitacionesPendientes(req.organizationId),
    ]);

    res.json({ miembros, invitaciones, roles: rolesAsignables() });
  } catch (error) {
    next(error);
  }
}

export async function crearInvitacion(req, res, next) {
  try {
    const creada = await invitar({
      organizationId: req.organizationId,
      invitadoPor: req.usuario.id,
      correo: req.body?.correo,
      rol: req.body?.rol,
    });

    res.status(201).json(creada);
  } catch (error) {
    next(error);
  }
}

export async function eliminarInvitacion(req, res, next) {
  try {
    await cancelarInvitacion(req.organizationId, req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function actualizarRol(req, res, next) {
  try {
    res.json(
      await cambiarRol({
        organizationId: req.organizationId,
        miembroId: req.params.id,
        rol: req.body?.rol,
        userId: req.usuario.id,
      }),
    );
  } catch (error) {
    next(error);
  }
}

export async function eliminar(req, res, next) {
  try {
    await quitarMiembro({
      organizationId: req.organizationId,
      miembroId: req.params.id,
      userId: req.usuario.id,
    });

    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function verInvitacionPublica(req, res, next) {
  try {
    const { id, correo, rol, venceEl } = await verInvitacion(req.params.id);
    // No se devuelve el organizationId: quien todavia no acepto no necesita
    // saber nada del comercio mas alla de a que rol lo invitan.
    res.json({ id, correo, rol, venceEl });
  } catch (error) {
    next(error);
  }
}

export async function aceptar(req, res, next) {
  try {
    res.json(
      await aceptarInvitacion({
        invitacionId: req.params.id,
        userId: req.usuario.id,
      }),
    );
  } catch (error) {
    next(error);
  }
}
