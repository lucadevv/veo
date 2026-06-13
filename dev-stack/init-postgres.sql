-- Inicialización del Postgres de desarrollo
-- Crea schemas por servicio + extensiones requeridas.
-- En producción esto lo hace Terraform + Prisma migrations.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Schemas por servicio (multi-tenant lógico dentro del mismo cluster)
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS trip;
CREATE SCHEMA IF NOT EXISTS dispatch;
CREATE SCHEMA IF NOT EXISTS payment;
CREATE SCHEMA IF NOT EXISTS panic;
CREATE SCHEMA IF NOT EXISTS notification;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS rating;
CREATE SCHEMA IF NOT EXISTS share;
CREATE SCHEMA IF NOT EXISTS media;
CREATE SCHEMA IF NOT EXISTS fleet;
CREATE SCHEMA IF NOT EXISTS biometric;
CREATE SCHEMA IF NOT EXISTS chat;
CREATE SCHEMA IF NOT EXISTS places;

-- Usuario de aplicación (en prod cada servicio tiene su propio user con permisos mínimos)
-- En dev mantenemos uno solo por simplicidad.
GRANT ALL ON SCHEMA identity, trip, dispatch, payment, panic, notification, audit, rating, share, media, fleet, biometric, chat, places TO veo;
