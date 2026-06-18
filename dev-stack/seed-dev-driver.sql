-- Seed DEV: un conductor elegible + su vehículo, para simular el flujo de viaje sin la driver-app.
-- Idempotente (ON CONFLICT). Ejecutar: docker exec -i veo-postgres psql -U veo -d veo < dev-stack/seed-dev-driver.sql
-- UUIDs fijos: el vehículo (fleet) referencia al User.id del conductor (identity) — cross-schema, sin FK.

-- (1) Usuario conductor en identity: type DRIVER + KYC VERIFIED (elegibilidad).
INSERT INTO identity.users (id, phone, name, type, kyc_status, kyc_verified_at, created_at, updated_at)
VALUES ('d0000000-0000-4000-8000-000000000001', '+51999000001', 'Carlos Conductor (DEV)', 'DRIVER', 'VERIFIED', now(), now(), now())
ON CONFLICT (id) DO UPDATE SET type = 'DRIVER', kyc_status = 'VERIFIED', kyc_verified_at = now(), updated_at = now();

-- (2) Perfil Driver: AVAILABLE + background CLEARED + sin suspender (pasa el gate de elegibilidad del dispatch).
INSERT INTO identity.drivers (id, user_id, current_status, background_check_status, face_embedding,
                              license_number, legal_name, average_rating, total_trips, last_verified_at,
                              created_at, updated_at)
VALUES ('d0000000-0000-4000-8000-0000000000a1', 'd0000000-0000-4000-8000-000000000001', 'AVAILABLE', 'CLEARED', '{}',
        'LIC-DEV-001', 'Carlos Conductor', 4.90, 120, now(), now(), now())
ON CONFLICT (user_id) DO UPDATE SET current_status = 'AVAILABLE', background_check_status = 'CLEARED',
                                    suspended_at = NULL, updated_at = now();

-- (3) Vehículo en fleet: driver_id = User.id del conductor (para el enriquecimiento de la oferta en el BFF).
INSERT INTO fleet.vehicles (id, plate, make, model, year, color, vehicle_type, driver_id, doc_status, active,
                            insurance_expires_at, created_at, updated_at)
VALUES ('d0000000-0000-4000-8000-0000000000b1', 'ADV-123', 'Toyota', 'Yaris', 2022, 'Plomo', 'CAR',
        'd0000000-0000-4000-8000-000000000001', 'VALID', true, now() + interval '1 year', now(), now())
ON CONFLICT (id) DO UPDATE SET driver_id = 'd0000000-0000-4000-8000-000000000001', doc_status = 'VALID', active = true,
                               insurance_expires_at = now() + interval '1 year', updated_at = now();

-- (4) DOCUMENTOS de flota (BR-I04), todos VÁLIDOS y verificados, con vencimiento futuro.
--   IMPORTANTE: fleet GetDriverDocuments consulta SOLO owner_type=DRIVER con owner_id = driver.id
--   (el id del PERFIL Driver de identity, d0...a1 — NO el User.id). Los 5 documentos de compliance
--   (LICENSE_A1, SOAT, PROPERTY_CARD, BACKGROUND_CHECK, ITV) cuelgan del DRIVER, no del vehículo.
INSERT INTO fleet.fleet_documents
  (id, owner_type, owner_id, type, document_number, issued_at, expires_at, status, verified_at, created_at, updated_at)
VALUES
  ('d0000000-0000-4000-8000-0000000000c1', 'DRIVER', 'd0000000-0000-4000-8000-0000000000a1', 'LICENSE_A1',       'Q-12345678',   now() - interval '6 months', now() + interval '2 years',  'VALID', now(), now(), now()),
  ('d0000000-0000-4000-8000-0000000000c2', 'DRIVER', 'd0000000-0000-4000-8000-0000000000a1', 'BACKGROUND_CHECK', 'ANT-DEV-001',  now() - interval '1 month',  now() + interval '1 year',   'VALID', now(), now(), now()),
  ('d0000000-0000-4000-8000-0000000000c3', 'DRIVER', 'd0000000-0000-4000-8000-0000000000a1', 'SOAT',             'SOAT-DEV-001', now() - interval '1 month',  now() + interval '1 year',   'VALID', now(), now(), now()),
  ('d0000000-0000-4000-8000-0000000000c4', 'DRIVER', 'd0000000-0000-4000-8000-0000000000a1', 'PROPERTY_CARD',    'PROP-DEV-001', now() - interval '1 year',   now() + interval '5 years',  'VALID', now(), now(), now()),
  ('d0000000-0000-4000-8000-0000000000c5', 'DRIVER', 'd0000000-0000-4000-8000-0000000000a1', 'ITV',              'ITV-DEV-001',  now() - interval '1 month',  now() + interval '6 months', 'VALID', now(), now(), now())
ON CONFLICT (id) DO UPDATE SET owner_type = 'DRIVER', owner_id = 'd0000000-0000-4000-8000-0000000000a1',
                               status = 'VALID', expires_at = EXCLUDED.expires_at, verified_at = now(), updated_at = now();
