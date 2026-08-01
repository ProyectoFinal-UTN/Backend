import { pgTable, serial, varchar } from "drizzle-orm/pg-core";

export const usuarios = pgTable("usuarios", {
  id: serial("id").primaryKey(),
  correo: varchar("correo", { length: 255 }).notNull().unique(),
  rol: varchar("rol", { length: 20 }).notNull(), // propietario | gerente | empleado
});