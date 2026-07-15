-- Compliance P0 (Ley 29733): el DNI del conductor deja de persistir EN CLARO. Pasa a cifrado en reposo
-- (AES-256-GCM · secret-box, formato `iv.tag.enc` base64) en una columna NUEVA `document_id_enc`.
--
-- DROP + ADD (no RENAME) DELIBERADO: el contenido cambia de semántica (plaintext → ciphertext); un
-- plaintext viejo NO es descifrable como ciphertext, así que arrastrarlo sería data corrupta. La app driver
-- (Ola 4) aún NO está en producción → NO hay DNI real que migrar; la columna vieja se descarta limpia.
-- El DNI lo descifra identity en el borde gRPC para mostrarlo a compliance (cifrado REVERSIBLE, no hash).

-- AlterTable
ALTER TABLE "identity"."drivers" DROP COLUMN "document_id";
ALTER TABLE "identity"."drivers" ADD COLUMN "document_id_enc" TEXT;
