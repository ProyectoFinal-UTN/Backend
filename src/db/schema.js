import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/* ---------------------------------------------------------------------------
 * Tablas de Better Auth
 *
 * Generadas con `npm run auth:generate` (CLI oficial `auth`). No se editan a
 * mano: si hace falta cambiarlas (agregar un plugin, un campo extra), se
 * ajusta src/lib/auth.js y se vuelve a correr el generador.
 *
 * Ojo con el CLI viejo `@better-auth/cli`: esta deprecado y genera un schema
 * de una version anterior (le falta `account.issuer`, entre otras cosas), con
 * lo cual el registro rompe con un 500 al insertar en `account`.
 * ------------------------------------------------------------------------- */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("account_issuer_accountId_uidx").on(
      table.issuer,
      table.accountId,
    ),
    index("account_userId_idx").on(table.userId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull(),
  metadata: text("metadata"),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // propietario | gerente | empleado (RF9). Ver src/lib/permissions.js
    role: text("role").default("empleado").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

/* ---------------------------------------------------------------------------
 * Tablas propias
 * ------------------------------------------------------------------------- */

/**
 * Datos del negocio, 1:1 con ORGANIZATION de Better Auth.
 *
 * Existe para colgarle atributos del comercio sin tocar el schema de Better
 * Auth. `comercio.id` es la clave de tenant: toda tabla de negocio lleva un
 * `comercio_id` que apunta aca, y ninguna query puede omitir ese filtro
 * (ver references/data-model.md).
 *
 * Solo `organizationId` y `nombre` son obligatorios a nivel base. El resto de
 * los campos los completa y valida HU-6 (alta del perfil del comercio).
 */
export const comercio = pgTable(
  "comercio",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .unique()
      .references(() => organization.id, { onDelete: "cascade" }),
    nombre: varchar("nombre", { length: 150 }).notNull(),
    rubro: varchar("rubro", { length: 100 }),
    direccion: varchar("direccion", { length: 255 }),
    telefono: varchar("telefono", { length: 40 }),
    correoContacto: varchar("correo_contacto", { length: 255 }),
    moneda: varchar("moneda", { length: 3 }).default("ARS").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("comercio_organizationId_uidx").on(table.organizationId),
  ],
);

/**
 * Lugares fisicos donde el comercio guarda stock (HU-8).
 *
 * Es una tabla y no un enum a proposito: cada comercio define las suyas, no
 * hay un "local"/"deposito" fijo. No hardcodear nombres de ubicacion en ningun
 * repo (ver references/data-model.md).
 *
 * El stock de un producto se lleva por `(producto, ubicacion)`, y el total del
 * producto es la suma de sus ubicaciones.
 */
export const ubicacion = pgTable(
  "ubicacion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    comercioId: uuid("comercio_id")
      .notNull()
      .references(() => comercio.id, { onDelete: "cascade" }),
    nombre: varchar("nombre", { length: 100 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // Dos ubicaciones con el mismo nombre en un mismo comercio no tienen
    // sentido y harian ambigua cualquier lectura de stock. Entre comercios
    // distintos si pueden repetirse.
    uniqueIndex("ubicacion_comercioId_nombre_uidx").on(
      table.comercioId,
      table.nombre,
    ),
    index("ubicacion_comercioId_idx").on(table.comercioId),
  ],
);

/**
 * Catalogo de productos del comercio (HU-9).
 *
 * El "stock actual" del formulario de alta NO vive aca: PRODUCTO son los
 * datos del articulo, STOCK es la cantidad por ubicacion (ver mas abajo). El
 * codigo de barras es unico por comercio, no global: dos comercios distintos
 * pueden vender el mismo producto con el mismo codigo.
 *
 * `activo` habilita el borrado logico: eliminar un producto no borra la fila
 * (dejaria huerfano su `stock` y, mas adelante, su historial de `movimiento`),
 * solo lo saca de las lecturas normales.
 */
export const producto = pgTable(
  "producto",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    comercioId: uuid("comercio_id")
      .notNull()
      .references(() => comercio.id, { onDelete: "cascade" }),
    nombre: varchar("nombre", { length: 150 }).notNull(),
    codigoBarras: varchar("codigo_barras", { length: 64 }).notNull(),
    categoria: varchar("categoria", { length: 100 }).notNull(),
    unidadMedida: varchar("unidad_medida", { length: 20 }).notNull(),
    umbralMinimo: integer("umbral_minimo").default(0).notNull(),
    activo: boolean("activo").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("producto_comercioId_idx").on(table.comercioId),
    // Parcial: solo exige unicidad entre productos activos. Sin esto, borrar
    // un producto (soft delete) bloquearia su codigo de barras para siempre,
    // porque la fila inactiva seguiria contando para el indice.
    uniqueIndex("producto_comercio_codigoBarras_uidx")
      .on(table.comercioId, table.codigoBarras)
      .where(sql`${table.activo} = true`),
  ],
);

/**
 * Saldo de stock por producto y ubicacion (HU-9 lo crea, HU-13 lo mantiene).
 *
 * Cache del libro de movimientos (ver data-model.md): una fila por
 * `(producto, ubicacion)`, se actualiza siempre en la misma transaccion que
 * el movimiento que la origina. Lleva `comercio_id` propio, denormalizado
 * desde `producto.comercioId`, para poder filtrar sin depender de acordarse
 * de hacer el join con `producto` en cada query futura — un producto nunca
 * cambia de comercio, asi que no hay riesgo de que se desincronice.
 */
export const stock = pgTable(
  "stock",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    comercioId: uuid("comercio_id")
      .notNull()
      .references(() => comercio.id, { onDelete: "cascade" }),
    productoId: uuid("producto_id")
      .notNull()
      .references(() => producto.id, { onDelete: "cascade" }),
    ubicacionId: uuid("ubicacion_id")
      .notNull()
      .references(() => ubicacion.id, { onDelete: "cascade" }),
    cantidad: integer("cantidad").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("stock_producto_ubicacion_uidx").on(
      table.productoId,
      table.ubicacionId,
    ),
    index("stock_productoId_idx").on(table.productoId),
    index("stock_ubicacionId_idx").on(table.ubicacionId),
    index("stock_comercioId_idx").on(table.comercioId),
  ],
);

/**
 * Tipos de movimiento del libro de stock (HU-13).
 *
 * "transferencia" se declara desde ahora aunque el endpoint de HU-13 la
 * rechace: agregar un valor a un enum de Postgres despues obliga a un
 * ALTER TYPE ... ADD VALUE en una migracion aparte, y HU-12 —que es la que lo
 * usa, con dos filas ligadas por `transferencia_id`— es la siguiente en la
 * fila. Los cinco valores son los de references/data-model.md.
 */
export const tipoMovimiento = pgEnum("tipo_movimiento", [
  "compra",
  "venta",
  "ajuste",
  "merma",
  "transferencia",
]);

/**
 * Directorio de proveedores del comercio (HU-19).
 *
 * El "contacto" de la HU se guarda en tres columnas y no en una de texto libre:
 * la persona (`contacto`), el `telefono` y el `correo`, igual que en `comercio`.
 * Con un solo campo no se puede ni llamar ni escribir sin interpretar a mano
 * lo que alguien tipeo.
 *
 * Baja logica (`activo`), como `producto`: los movimientos de compra apuntan
 * aca (`movimiento.proveedor_id`) y el historial de compras por proveedor
 * (HU-21) tiene que seguir mostrando a quien se le compro, aunque hoy ya no se
 * le compre mas.
 *
 * Se relaciona con `producto` en N:M a traves de PRODUCTO_PROVEEDOR (HU-20).
 */
export const proveedor = pgTable(
  "proveedor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    comercioId: uuid("comercio_id")
      .notNull()
      .references(() => comercio.id, { onDelete: "cascade" }),
    nombre: varchar("nombre", { length: 150 }).notNull(),
    contacto: varchar("contacto", { length: 150 }),
    telefono: varchar("telefono", { length: 40 }),
    correo: varchar("correo", { length: 255 }),
    rubro: varchar("rubro", { length: 100 }),
    // Texto libre a proposito ("contado", "30 dias", "50% al pedir"): las
    // condiciones las fija cada proveedor y no entran en una lista cerrada.
    condicionesPago: varchar("condiciones_pago", { length: 255 }),
    activo: boolean("activo").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("proveedor_comercioId_idx").on(table.comercioId),
    // Un nombre por comercio, sin distinguir mayusculas ("Distribuidora Sur" y
    // "distribuidora sur" son el mismo proveedor). Parcial, igual que el de
    // codigo de barras de `producto`: un proveedor dado de baja no bloquea que
    // se vuelva a cargar con el mismo nombre.
    uniqueIndex("proveedor_comercio_nombre_uidx")
      .on(table.comercioId, sql`lower(${table.nombre})`)
      .where(sql`${table.activo} = true`),
  ],
);

/**
 * A quien se le puede comprar cada producto (HU-20). N:M: un producto puede
 * tener varios proveedores y un proveedor vende varios productos.
 *
 * La clave es el par (producto, proveedor): asociar dos veces lo mismo no tiene
 * significado, y con la PK compuesta la base lo impide sola en vez de depender
 * de un SELECT previo con su ventana de carrera.
 *
 * `comercio_id` denormalizado, por lo mismo que en `stock`: para filtrar sin
 * acordarse del join. Que producto y proveedor sean de ESE comercio lo valida
 * el service antes de insertar; la base no puede chequearlo con una FK.
 *
 * `cascade` en las dos FK, a diferencia de `movimiento`: esto no es un libro,
 * es un vinculo vigente. Igual hoy no se dispara nunca, porque producto y
 * proveedor se borran logicamente; el vinculo con uno dado de baja queda en la
 * tabla y las consultas lo filtran por `activo`.
 */
export const productoProveedor = pgTable(
  "producto_proveedor",
  {
    comercioId: uuid("comercio_id")
      .notNull()
      .references(() => comercio.id, { onDelete: "cascade" }),
    productoId: uuid("producto_id")
      .notNull()
      .references(() => producto.id, { onDelete: "cascade" }),
    proveedorId: uuid("proveedor_id")
      .notNull()
      .references(() => proveedor.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.productoId, table.proveedorId] }),
    // La PK ya sirve para "proveedores de un producto" (producto_id va
    // primero). Este es para el otro sentido: "productos de un proveedor".
    index("producto_proveedor_proveedorId_idx").on(table.proveedorId),
  ],
);

/**
 * Libro de movimientos de stock (HU-13). Fuente de verdad del inventario.
 *
 * Es append-only: una fila nunca se edita ni se borra, y `cantidad` se guarda
 * con signo (entrada +, salida -). `stock` es la cache del saldo, y se
 * actualiza siempre en la misma transaccion que inserta el movimiento que la
 * origina (ver aplicarMovimiento en services/movimientos.service.js). El
 * invariante que sostiene todo el modelo es:
 *
 *   STOCK.cantidad = SUM(MOVIMIENTO.cantidad) para ese (producto, ubicacion)
 *
 * No lleva `createdAt` ni `updatedAt`, a diferencia del resto de las tablas
 * propias: `fecha` ya es el momento de insercion, y un `updatedAt` contradiria
 * que la fila no se modifica nunca.
 */
export const movimiento = pgTable(
  "movimiento",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    comercioId: uuid("comercio_id")
      .notNull()
      .references(() => comercio.id, { onDelete: "cascade" }),
    // restrict y no cascade: el libro es append-only, asi que borrar un
    // producto o una ubicacion no puede llevarse puesto su historial.
    // `producto` ya se borra logicamente (`activo`); esto le da a `ubicacion`
    // la proteccion que pedia el comentario de eliminarUbicacion.
    productoId: uuid("producto_id")
      .notNull()
      .references(() => producto.id, { onDelete: "restrict" }),
    ubicacionId: uuid("ubicacion_id")
      .notNull()
      .references(() => ubicacion.id, { onDelete: "restrict" }),
    // text y no uuid: los ids de Better Auth son text (ver la tabla `user`).
    usuarioId: text("usuario_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    tipo: tipoMovimiento("tipo").notNull(),
    cantidad: integer("cantidad").notNull(),
    // Motivo del movimiento (HU-15). Nullable en la base a proposito: una
    // compra o una venta no lo necesitan, y las transferencias de HU-12 se
    // explican solas por el par ligado. La obligatoriedad para `ajuste` y
    // `merma` se valida en movimientos.service.js y no con un NOT NULL, que
    // ademas romperia las filas que el libro ya tiene cargadas (el libro es
    // append-only: no se pueden completar hacia atras).
    motivo: varchar("motivo", { length: 255 }),
    // A quien se le compro (HU-19). `restrict`: un proveedor con movimientos
    // no se borra, se da de baja logica. Nullable: solo aplica a compras, y
    // tampoco es obligatorio en ellas.
    proveedorId: uuid("proveedor_id").references(() => proveedor.id, {
      onDelete: "restrict",
    }),
    // Liga las dos patas de una transferencia (HU-12): la fila con cantidad
    // negativa en la ubicacion de origen y la positiva en la de destino
    // comparten este id. Nullable: los movimientos que no son transferencias
    // —que son la mayoria— no tienen ninguno.
    transferenciaId: uuid("transferencia_id").references(
      () => transferencia.id,
      { onDelete: "restrict" },
    ),
    fecha: timestamp("fecha").defaultNow().notNull(),
  },
  (table) => [
    index("movimiento_comercioId_idx").on(table.comercioId),
    // Es el indice del recalculo del saldo desde el libro: SUM(cantidad)
    // filtrando por el par (producto, ubicacion).
    index("movimiento_producto_ubicacion_idx").on(
      table.productoId,
      table.ubicacionId,
    ),
    index("movimiento_ubicacionId_idx").on(table.ubicacionId),
    // Para el filtro por rango de fechas del historial (HU-14).
    index("movimiento_fecha_idx").on(table.fecha),
    // Para el historial de compras de un proveedor (HU-21): el filtro es
    // siempre proveedor + rango de fecha, y el orden tambien es por fecha, asi
    // que el compuesto sirve para los tres pasos de una sola pasada. Sin el, la
    // query escanea el libro entero: `proveedor_id` no tenia ningun indice.
    // Sin `DESC` en la definicion: Postgres recorre un btree para atras sin
    // costo extra. De paso le da indice al chequeo del `restrict` de la FK.
    index("movimiento_proveedor_fecha_idx").on(table.proveedorId, table.fecha),
    // Para traer las dos patas de una transferencia sin escanear el libro
    // entero (HU-12).
    index("movimiento_transferenciaId_idx").on(table.transferenciaId),
  ],
);

/**
 * Encabezado de una transferencia de stock entre dos ubicaciones (HU-12).
 *
 * El movimiento real de la mercaderia son las DOS filas de `movimiento` que
 * comparten `transferencia_id`: -N en la ubicacion de origen, +N en la de
 * destino. Esta tabla guarda una sola vez lo que es comun a las dos —origen,
 * destino, quien la hizo y por que— y nada mas.
 *
 * No lleva `producto_id` ni `cantidad` a proposito: los dicen los dos
 * movimientos, y repetirlos aca crearia un segundo invariante que mantener
 * sincronizado con el libro (el modelo ya tiene uno, el de `stock`). Ademas
 * deja abierta la transferencia de varios productos de una: serian 2N
 * movimientos colgando del mismo encabezado, sin migrar la tabla.
 *
 * Tampoco lleva `proveedor_id`: una transferencia es un movimiento interno
 * entre dos ubicaciones del mismo comercio, no hay contraparte externa. El
 * proveedor de esa mercaderia esta en el movimiento de compra que la hizo
 * entrar.
 *
 * Sin `createdAt`/`updatedAt`, igual que `movimiento` y por lo mismo: `fecha`
 * ya es el momento de insercion, y la fila no se modifica nunca.
 */
export const transferencia = pgTable(
  "transferencia",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    comercioId: uuid("comercio_id")
      .notNull()
      .references(() => comercio.id, { onDelete: "cascade" }),
    // restrict y no cascade, igual que en `movimiento`: la transferencia es
    // parte del libro append-only, asi que borrar una ubicacion o un usuario
    // no puede llevarse puesto el registro de que la mercaderia se movio.
    ubicacionOrigenId: uuid("ubicacion_origen_id")
      .notNull()
      .references(() => ubicacion.id, { onDelete: "restrict" }),
    ubicacionDestinoId: uuid("ubicacion_destino_id")
      .notNull()
      .references(() => ubicacion.id, { onDelete: "restrict" }),
    // text y no uuid: los ids de Better Auth son text (ver la tabla `user`).
    usuarioId: text("usuario_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    // Opcional: a diferencia del ajuste y la merma (HU-15), una transferencia
    // se explica sola por el par ligado. Si viene, se guarda tambien en los
    // dos movimientos.
    motivo: varchar("motivo", { length: 255 }),
    fecha: timestamp("fecha").defaultNow().notNull(),
  },
  (table) => [
    index("transferencia_comercioId_idx").on(table.comercioId),
    // Las FK hacia `ubicacion` son RESTRICT: cada DELETE /api/ubicaciones/:id
    // obliga a Postgres a buscar si alguna transferencia la referencia, y sin
    // indice eso es un scan de la tabla entera. Mismo motivo que
    // `movimiento_ubicacionId_idx`. `usuario_id` queda sin indice igual que
    // en `movimiento`: borrar un usuario es raro y no es un camino del negocio.
    index("transferencia_ubicacionOrigenId_idx").on(table.ubicacionOrigenId),
    index("transferencia_ubicacionDestinoId_idx").on(table.ubicacionDestinoId),
    // La validacion de origen != destino esta en el service y devuelve un 400
    // con mensaje; esto es la red de abajo, para que ninguna escritura futura
    // pueda dejar una transferencia de una ubicacion a si misma (que movería
    // stock contra si mismo y dejaria dos movimientos que se cancelan).
    check(
      "transferencia_ubicaciones_distintas_check",
      sql`${table.ubicacionOrigenId} <> ${table.ubicacionDestinoId}`,
    ),
  ],
);

/**
 * Dispositivos que reciben las notificaciones push de reposicion (HU-18).
 *
 * Una fila por navegador suscripto: es lo que devuelve `PushSubscription` en el
 * Frontend (`endpoint` + las dos claves con las que se cifra el mensaje). Sin
 * fila no hay push, asi que silenciar las notificaciones es borrarla; no hay
 * una preferencia aparte en ningun otro lado.
 *
 * `endpoint` es unico y no `(usuario, endpoint)`: identifica al navegador, no
 * a la persona. Si en un mismo celular se loguea otro usuario y se suscribe,
 * la fila se reasigna a el; si fueran dos filas, el celular recibiria los
 * avisos de los dos comercios.
 *
 * `cascade` hacia `comercio` y `user`, a diferencia de `movimiento`: esto no es
 * historia, y una suscripcion de alguien que ya no existe solo serviria para
 * mandarle avisos a un dispositivo que nadie va a leer.
 */
export const suscripcionPush = pgTable(
  "suscripcion_push",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    comercioId: uuid("comercio_id")
      .notNull()
      .references(() => comercio.id, { onDelete: "cascade" }),
    // text y no uuid: los ids de Better Auth son text (ver la tabla `user`).
    usuarioId: text("usuario_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // text y no varchar: las URLs de los servicios de push no tienen un largo
    // maximo documentado, y cortarla la dejaria inservible.
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: varchar("user_agent", { length: 255 }),
    // `expirationTime` de la suscripcion, si el navegador lo informa. Casi
    // siempre viene null: el vencimiento real se entera recien al enviar
    // (404/410), y ahi la fila se borra.
    expiraEn: timestamp("expira_en"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("suscripcion_push_endpoint_uidx").on(table.endpoint),
    // Para "a quien le aviso" cuando un producto del comercio cruza el umbral.
    index("suscripcion_push_comercioId_idx").on(table.comercioId),
    index("suscripcion_push_usuarioId_idx").on(table.usuarioId),
  ],
);

/* ---------------------------------------------------------------------------
 * Relaciones
 * ------------------------------------------------------------------------- */

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const organizationRelations = relations(
  organization,
  ({ many, one }) => ({
    members: many(member),
    invitations: many(invitation),
    comercio: one(comercio, {
      fields: [organization.id],
      references: [comercio.organizationId],
    }),
  }),
);

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, { fields: [member.userId], references: [user.id] }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, { fields: [invitation.inviterId], references: [user.id] }),
}));

export const comercioRelations = relations(comercio, ({ many, one }) => ({
  organization: one(organization, {
    fields: [comercio.organizationId],
    references: [organization.id],
  }),
  ubicaciones: many(ubicacion),
  productos: many(producto),
  proveedores: many(proveedor),
  movimientos: many(movimiento),
}));

export const proveedorRelations = relations(proveedor, ({ one, many }) => ({
  comercio: one(comercio, {
    fields: [proveedor.comercioId],
    references: [comercio.id],
  }),
  movimientos: many(movimiento),
  productos: many(productoProveedor),
}));

export const productoProveedorRelations = relations(
  productoProveedor,
  ({ one }) => ({
    producto: one(producto, {
      fields: [productoProveedor.productoId],
      references: [producto.id],
    }),
    proveedor: one(proveedor, {
      fields: [productoProveedor.proveedorId],
      references: [proveedor.id],
    }),
  }),
);

export const ubicacionRelations = relations(ubicacion, ({ one, many }) => ({
  comercio: one(comercio, {
    fields: [ubicacion.comercioId],
    references: [comercio.id],
  }),
  stocks: many(stock),
  movimientos: many(movimiento),
}));

export const productoRelations = relations(producto, ({ one, many }) => ({
  comercio: one(comercio, {
    fields: [producto.comercioId],
    references: [comercio.id],
  }),
  stocks: many(stock),
  movimientos: many(movimiento),
  proveedores: many(productoProveedor),
}));

export const stockRelations = relations(stock, ({ one }) => ({
  producto: one(producto, {
    fields: [stock.productoId],
    references: [producto.id],
  }),
  ubicacion: one(ubicacion, {
    fields: [stock.ubicacionId],
    references: [ubicacion.id],
  }),
}));

// `transferenciaId` no tiene relacion declarada aca: HU-12 agrego la FK pero no
// la relacion. `proveedor` si (HU-19).
export const movimientoRelations = relations(movimiento, ({ one }) => ({
  comercio: one(comercio, {
    fields: [movimiento.comercioId],
    references: [comercio.id],
  }),
  producto: one(producto, {
    fields: [movimiento.productoId],
    references: [producto.id],
  }),
  ubicacion: one(ubicacion, {
    fields: [movimiento.ubicacionId],
    references: [ubicacion.id],
  }),
  usuario: one(user, {
    fields: [movimiento.usuarioId],
    references: [user.id],
  }),
  proveedor: one(proveedor, {
    fields: [movimiento.proveedorId],
    references: [proveedor.id],
  }),
}));

/**
 * Registro de accesos y acciones (HU-5).
 *
 * Es un libro append-only: nunca se edita ni se borra una fila. Solo lo lee el
 * propietario, y ese permiso vive en `src/lib/permissions.js`.
 *
 * `usuarioId` es `set null` y ademas se guarda el correo como copia: si algun
 * dia se borra un usuario, el rastro de lo que hizo tiene que sobrevivir. Un
 * registro de auditoria que se vacia cuando se va la persona no sirve de nada.
 */
export const auditoria = pgTable(
  "auditoria",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    comercioId: uuid("comercio_id")
      .notNull()
      .references(() => comercio.id, { onDelete: "cascade" }),
    usuarioId: text("usuario_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Copia del correo al momento del hecho, para que la fila se entienda sola.
    usuarioCorreo: varchar("usuario_correo", { length: 255 }),
    // inicio_sesion | crear | editar | eliminar
    accion: varchar("accion", { length: 30 }).notNull(),
    // sesion | producto | ubicacion | movimiento | comercio | miembro | ...
    recurso: varchar("recurso", { length: 40 }).notNull(),
    recursoId: varchar("recurso_id", { length: 100 }),
    detalle: varchar("detalle", { length: 255 }),
    ip: varchar("ip", { length: 45 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    // La pantalla siempre pide "lo ultimo de este comercio", asi que el indice
    // va por comercio y fecha descendente.
    index("auditoria_comercioId_createdAt_idx").on(
      table.comercioId,
      table.createdAt,
    ),
  ],
);

export const auditoriaRelations = relations(auditoria, ({ one }) => ({
  comercio: one(comercio, {
    fields: [auditoria.comercioId],
    references: [comercio.id],
  }),
  usuario: one(user, {
    fields: [auditoria.usuarioId],
    references: [user.id],
  }),
}));
