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
                            created_at, updated_at)
VALUES ('d0000000-0000-4000-8000-0000000000b1', 'ADV-123', 'Toyota', 'Yaris', 2022, 'Plomo', 'CAR',
        'd0000000-0000-4000-8000-000000000001', 'VALID', true, now(), now())
ON CONFLICT (id) DO UPDATE SET driver_id = 'd0000000-0000-4000-8000-000000000001', doc_status = 'VALID', active = true,
                               updated_at = now();
