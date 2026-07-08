-- ─────────────────────────────────────────────────────────────────────────────
-- Seed DEV de FLOTA — alimenta las 3 pantallas de flota del admin
-- (Conductores · Vehículos · Revisiones) dejando estados PENDING / en-cola para
-- poder probar APROBAR y RECHAZAR, sin depender de la driver-app.
--
--   Ejecutar:  docker exec -i veo-postgres psql -U veo -d veo < dev-stack/seed-fleet-dev.sql
--   (o vía)    dev-stack/veo.sh seed-fleet   ← además imprime los IDs sembrados.
--
-- Hermano de seed-finance-dev.sql: mismo estilo (IDs FIJOS + idempotente + ventanas
-- de fecha calculadas en SQL con now()+intervalos, UTC-safe, NUNCA hardcodeadas).
--
-- CROSS-SCHEMA sin FK: identity (User/Driver) y fleet (Vehicle/FleetDocument/Inspection)
-- viven en schemas Postgres distintos y se referencian por id (sin FK dura). El
-- `Vehicle.driver_id` es el **User.id** de identity (no el id de perfil Driver) — decisión
-- documentada en el schema de fleet.
--
-- IDEMPOTENTE + RE-ARMABLE: IDs fijos con prefijo `d1000000-…` (el conductor DEV elegible
-- de seed-dev-driver.sql usa `d0000000-…`; finanzas usa `f0000000-…`). Cada fila usa
-- ON CONFLICT DO UPDATE para RE-ARMAR el estado de prueba en cada corrida: si en un test
-- aprobaste/rechazaste al conductor o revisaste los docs, re-correr el seed los devuelve a
-- PENDING / PENDING_REVIEW. Re-ejecutable sin duplicar filas.
--
-- QUÉ ENCIENDE CADA COSA:
--   1) Conductor PENDING (identity)        → cola /ops/drivers/pending + summary + Revisiones.
--      + evento driver.registered (outbox) → read-model Redis → lista "Todos" de Conductores.
--   2) Vehículo + 2 docs VEHICLE PENDING   → Vehículos "En revisión" + esos docs en Revisiones.
--   3) Inspección vigente (ITV)            → card/columna ITV del vehículo en "Vigente".
--   4) 1 doc VEHICLE ya VALID              → variedad (un doc aprobado junto a los pendientes).
-- ─────────────────────────────────────────────────────────────────────────────


-- ── (1a) USUARIO del conductor postulante (identity). type DRIVER, KYC UNVERIFIED (aún no aprobado). ──
INSERT INTO identity.users (id, phone, name, type, kyc_status, face_embedding, created_at, updated_at)
VALUES ('d1000000-0000-4000-8000-000000000001', '+51999000002', 'Ana Postulante (DEV)', 'DRIVER', 'UNVERIFIED', '{}', now(), now())
ON CONFLICT (id) DO UPDATE
  SET type = 'DRIVER', kyc_status = 'UNVERIFIED', kyc_verified_at = NULL,
      name = EXCLUDED.name, updated_at = now();


-- ── (1b) PERFIL Driver PENDING (identity). background_check_status=PENDING → cae en la cola de aprobación. ──
--   Se sembran los campos que el gate de approve() EXIGE para que el operador PUEDA aprobar (no solo rechazar):
--     · face_embedding no vacío       (gate biométrico: hasFaceEmbedding)
--     · dni_face_matched_at != null   (gate de ejecución del binding DNI↔selfie)
--     · license_face_matched_at != null (gate de ejecución del binding licencia↔selfie)
--     · liveness_checked = true       (gate del liveness pasivo / anti-spoofing)
--   El DNI (document_id_enc) NO se siembra: es PII cifrada AES-256-GCM (formato iv.tag.enc) que no se puede
--   forjar en SQL. El operador ve nombre/licencia/face-match; el DNI sale como "no disponible" (degradación honesta).
INSERT INTO identity.drivers (
  id, user_id, license_number, legal_name, birth_date,
  current_status, background_check_status, average_rating, total_trips,
  face_embedding, face_enrolled_at,
  dni_face_matched, dni_face_match_score, dni_face_matched_at,
  license_face_matched, license_face_match_score, license_face_matched_at,
  liveness_checked, liveness_score,
  created_at, updated_at
) VALUES (
  'd1000000-0000-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-000000000001',
  'LIC-REV-002', 'Ana Postulante Quispe', DATE '1994-03-15',
  'OFFLINE', 'PENDING', 5.00, 0,
  '{0.11,0.22,0.33,0.44}', now(),
  true, 91.5, now(),
  true, 84.0, now(),
  true, 0.98,
  now(), now()
)
ON CONFLICT (user_id) DO UPDATE SET
  background_check_status = 'PENDING', current_status = 'OFFLINE',
  license_number = EXCLUDED.license_number, legal_name = EXCLUDED.legal_name,
  face_embedding = EXCLUDED.face_embedding, face_enrolled_at = now(),
  dni_face_matched = true, dni_face_match_score = 91.5, dni_face_matched_at = now(),
  license_face_matched = true, license_face_match_score = 84.0, license_face_matched_at = now(),
  liveness_checked = true, liveness_score = 0.98,
  rejection_reason = NULL, rejected_at = NULL, suspended_at = NULL,
  updated_at = now();


-- ── (1c) OUTBOX de identity: evento `driver.registered` (mismo shape que emite materializeDriverShell). ──
--   El relay del identity-service VIVO lo publica → Kafka → el kafka-consumer del admin-bff hace upsert PENDING
--   en el read-model Redis → el conductor aparece en la lista "Todos" de Conductores (que NO lee la DB directo).
--   Envelope canónico de @veo/events (envelopeSchema): eventId/eventType/occurredAt/producer/schemaVersion/payload.
--   aggregate_id = driver.id (el id de PERFIL); payload.driverId = driver.id, payload.userId = User.id.
--   ON CONFLICT re-arma la publicación (published_at=NULL) para que el relay lo re-emita en cada corrida del seed.
INSERT INTO identity.outbox_events (id, aggregate_id, event_type, envelope, created_at)
VALUES (
  'd1000000-0000-4000-8000-0000000000f1',
  'd1000000-0000-4000-8000-0000000000a1',
  'driver.registered',
  jsonb_build_object(
    'eventId',       gen_random_uuid()::text,
    'eventType',     'driver.registered',
    'occurredAt',    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'producer',      'identity-service',
    'schemaVersion', 1,
    'payload', jsonb_build_object(
      'driverId',     'd1000000-0000-4000-8000-0000000000a1',
      'userId',       'd1000000-0000-4000-8000-000000000001',
      'registeredAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  ),
  now()
)
ON CONFLICT (id) DO UPDATE SET
  envelope     = EXCLUDED.envelope,
  created_at   = now(),
  published_at = NULL,
  claimed_at   = NULL,
  failed_at    = NULL;


-- ── (2a) VEHÍCULO en revisión (fleet). driver_id = User.id del conductor postulante. ──
--   model_spec_id se ELIGE dinámicamente del catálogo curado (un modelo CAR APPROVED existente) para que la
--   operabilidad PUEDA derivarse; make/model se snapshotean de esa ficha (histórico estable). Si el catálogo
--   estuviera vacío (env fresco) cae a NULL + make/model por defecto (referencia BLANDA, sin FK → no rompe).
INSERT INTO fleet.vehicles (
  id, plate, make, model, year, color, vehicle_type,
  driver_id, model_spec_id, doc_status, active, insurance_expires_at, created_at, updated_at
)
SELECT
  'd1000000-0000-4000-8000-0000000000b1', 'REV-456',
  COALESCE(s.make, 'Hyundai'), COALESCE(s.model, 'Accent'),
  2021, 'Blanco', 'CAR',
  'd1000000-0000-4000-8000-000000000001', s.id,
  'VALID', true, now() + interval '1 year', now(), now()
FROM (SELECT 1) base
LEFT JOIN LATERAL (
  SELECT id, make, model
  FROM fleet.vehicle_model_specs
  WHERE status = 'APPROVED' AND vehicle_type = 'CAR'
  ORDER BY make, model
  LIMIT 1
) s ON true
ON CONFLICT (id) DO UPDATE SET
  driver_id           = EXCLUDED.driver_id,
  model_spec_id       = EXCLUDED.model_spec_id,
  make                = EXCLUDED.make,
  model               = EXCLUDED.model,
  doc_status          = 'VALID',
  active              = true,
  insurance_expires_at = now() + interval '1 year',
  updated_at          = now();


-- ── (2b) DOCUMENTOS VEHICLE-scoped (owner_type=VEHICLE, owner_id=vehicle.id). ──
--   SOAT + ITV en PENDING_REVIEW → el vehículo aparece "En revisión" y ambos docs entran a la cola de Revisiones.
--   VEHICLE_PHOTO ya VALID → variedad (un doc aprobado conviviendo con los pendientes). Vencimientos futuros en SQL.
INSERT INTO fleet.fleet_documents
  (id, owner_type, owner_id, type, document_number, issued_at, expires_at, status, verified_at, created_at, updated_at)
VALUES
  ('d1000000-0000-4000-8000-0000000000c1', 'VEHICLE', 'd1000000-0000-4000-8000-0000000000b1', 'SOAT',          'SOAT-REV-001',  now() - interval '10 days', now() + interval '1 year',   'PENDING_REVIEW', NULL,  now(), now()),
  ('d1000000-0000-4000-8000-0000000000c2', 'VEHICLE', 'd1000000-0000-4000-8000-0000000000b1', 'ITV',           'ITV-REV-001',   now() - interval '10 days', now() + interval '6 months', 'PENDING_REVIEW', NULL,  now(), now()),
  ('d1000000-0000-4000-8000-0000000000c3', 'VEHICLE', 'd1000000-0000-4000-8000-0000000000b1', 'VEHICLE_PHOTO', 'VEH-PHOTO-001', NULL,                       NULL,                        'VALID',          now(), now(), now())
ON CONFLICT (id) DO UPDATE SET
  owner_type = 'VEHICLE',
  owner_id   = EXCLUDED.owner_id,
  type       = EXCLUDED.type,
  status     = EXCLUDED.status,
  expires_at = EXCLUDED.expires_at,
  verified_at = EXCLUDED.verified_at,
  updated_at = now();


-- ── (3) INSPECCIÓN técnica vigente (fleet) del vehículo → columna/card ITV en "Vigente". ──
--   passed=true + next_due_at futuro (dentro de la ventana trimestral). inspector_id = el conductor DEV existente
--   (cualquier uuid válido sirve como inspector sintético). Idempotente por PK (id): re-correr refresca el vencimiento.
INSERT INTO fleet.inspections (id, vehicle_id, inspector_id, inspected_at, passed, notes, next_due_at, created_at)
VALUES (
  'd1000000-0000-4000-8000-0000000000e1',
  'd1000000-0000-4000-8000-0000000000b1',
  'd0000000-0000-4000-8000-000000000001',
  now() - interval '10 days', true, 'Inspección técnica DEV — aprobada',
  now() + interval '80 days', now()
)
ON CONFLICT (id) DO UPDATE SET
  inspected_at = now() - interval '10 days',
  passed       = true,
  next_due_at  = now() + interval '80 days';
