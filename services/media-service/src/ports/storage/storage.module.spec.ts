/**
 * S3LiveAdapter — las URLs prefirmadas DEBEN firmarse contra el host PÚBLICO (S3_PUBLIC_BASE_URL),
 * no contra el endpoint INTERNO (S3_ENDPOINT). SigV4 firma el `host` dentro de la firma, así que un
 * cliente físico que no alcanza el host interno (p. ej. un teléfono en la LAN) necesita una URL cuyo
 * origin sea el host público — y esa URL debe nacer firmada contra ese host para ser válida.
 *
 * No se toca la red: getSignedUrl es puro (firma local), así que el origin de la URL devuelta es
 * evidencia suficiente de contra qué host se firmó.
 */
import { describe, it, expect } from 'vitest';
import { S3LiveAdapter, type S3Config } from './storage.module';

const INTERNAL_ENDPOINT = 'http://localhost:9002';
const PUBLIC_ENDPOINT = 'http://192.168.18.224:9002';
// Host ADMIN (browser del Mac): a propósito DISTINTO del público para probar la selección por
// audiencia (puerto distinto → origin verificable, sin depender de localhost vs IP real).
const ADMIN_ENDPOINT = 'http://localhost:9003';

function buildAdapter(): S3LiveAdapter {
  const cfg: S3Config = {
    endpoint: INTERNAL_ENDPOINT,
    publicEndpoint: PUBLIC_ENDPOINT,
    adminEndpoint: ADMIN_ENDPOINT,
    region: 'us-east-1',
    accessKey: 'veo_dev',
    secretKey: 'veo_dev_secret',
    bucket: 'veo-video-dev',
    forcePathStyle: true,
  };
  return new S3LiveAdapter(cfg);
}

describe('S3LiveAdapter · las URLs prefirmadas se firman contra el host PÚBLICO', () => {
  it('presignUploadUrl (PUT) devuelve una URL cuyo origin == S3_PUBLIC_BASE_URL (no S3_ENDPOINT)', async () => {
    const url = await buildAdapter().presignUploadUrl({
      bucket: 'veo-documents-dev',
      key: 'drivers/smoke/test.jpg',
      contentType: 'image/jpeg',
      expiresSeconds: 300,
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe(PUBLIC_ENDPOINT);
    expect(parsed.origin).not.toBe(INTERNAL_ENDPOINT);
    // forcePathStyle (MinIO): el bucket viaja en el path, no como subdominio.
    expect(parsed.pathname).toBe('/veo-documents-dev/drivers/smoke/test.jpg');
    // La firma SigV4 viaja en la query string.
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('presignDownloadUrl (GET) sin audiencia (default device) firma contra S3_PUBLIC_BASE_URL', async () => {
    const url = await buildAdapter().presignDownloadUrl({
      bucket: 'veo-documents-dev',
      key: 'drivers/smoke/test.jpg',
      expiresSeconds: 300,
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe(PUBLIC_ENDPOINT);
    expect(parsed.origin).not.toBe(INTERNAL_ENDPOINT);
    expect(parsed.pathname).toBe('/veo-documents-dev/drivers/smoke/test.jpg');
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it("presignDownloadUrl (GET) con audience 'admin' firma contra S3_ADMIN_BASE_URL (no el host LAN)", async () => {
    const url = await buildAdapter().presignDownloadUrl({
      bucket: 'veo-documents-dev',
      key: 'fleet/driver-1/license.pdf',
      expiresSeconds: 120,
      audience: 'admin',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe(ADMIN_ENDPOINT);
    expect(parsed.origin).not.toBe(PUBLIC_ENDPOINT);
    expect(parsed.pathname).toBe('/veo-documents-dev/fleet/driver-1/license.pdf');
    expect(parsed.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });
});
