-- CIERRE TOCTOU del ALTA de documentos (deuda marcada en documents.service.ts). El alta es check-then-act:
-- findActiveDocumentOnPrimary (CHECK: "¿ya hay un doc ACTIVO de este (owner_type, owner_id, type)?") y luego
-- INSERT (ACT). Leer del PRIMARY cerró el replica-lag, pero NO la concurrencia pura: dos altas SIMULTÁNEAS del
-- mismo documento pueden AMBAS leer `null` en el CHECK antes de que cualquiera ESCRIBA, y AMBAS insertar → dos
-- documentos ACTIVOS del mismo tipo para el mismo dueño (rompe el invariante "un solo doc activo por tipo/owner").
--
-- Cierre definitivo a nivel DB: índice PARCIAL UNIQUE sobre (owner_type, owner_id, type) restringido al SET
-- ACTIVO (PENDING_REVIEW / VALID / EXPIRING_SOON) — el MISMO set que consulta findActiveDocumentOnPrimary.
-- PARCIAL a propósito: REJECTED y EXPIRED quedan FUERA del unique, porque un doc rechazado/vencido se puede
-- RE-SUBIR legítimamente (una nueva fila ACTIVA del mismo tipo convive con las históricas inactivas). Un unique
-- TOTAL rompería ese flujo. Bajo carrera, el GANADOR inserta y el PERDEDOR recibe P2002; el service lo traduce
-- con @veo/database.isUniqueViolation → re-resuelve contra la fila ya commiteada (mismo arquetipo que
-- vehicles.create sobre `plate` e inspections.create sobre su natural key).
--
-- Prisma 5 NO expresa índices PARCIALES en schema.prisma → se crea por SQL crudo y se aplica con
-- `prisma migrate deploy` (el flujo de db:migrate de este repo). No se declara en el schema; el cliente generado
-- no lo necesita: el P2002 se detecta ESTRUCTURALMENTE (name + code), no por metadata de schema.
--
-- PRE-EXISTENTE: si el schema dev ya tuviera 2+ docs ACTIVOS del mismo (owner_type, owner_id, type) por una
-- carrera vieja, este CREATE UNIQUE INDEX fallaría. Es improbable (el CHECK secuencial ya prevenía el duplicado
-- salvo la ventana de carrera pura). Si ocurriera: dedup manual conservando el más reciente por created_at antes
-- de reintentar la migración.
CREATE UNIQUE INDEX IF NOT EXISTS "fleet_documents_active_owner_type_owner_id_type_key"
  ON "fleet"."fleet_documents" ("owner_type", "owner_id", "type")
  WHERE "status" IN ('PENDING_REVIEW', 'VALID', 'EXPIRING_SOON');
