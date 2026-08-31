import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
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
}));

export const ubicacionRelations = relations(ubicacion, ({ one }) => ({
  comercio: one(comercio, {
    fields: [ubicacion.comercioId],
    references: [comercio.id],
  }),
}));
