CREATE TABLE "usuarios" (
	"id" serial PRIMARY KEY NOT NULL,
	"correo" varchar(255) NOT NULL,
	"rol" varchar(20) NOT NULL,
	CONSTRAINT "usuarios_correo_unique" UNIQUE("correo")
);
