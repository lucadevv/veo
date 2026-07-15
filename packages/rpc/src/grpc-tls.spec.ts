/**
 * gRPC TLS env-gated (ADR-016): degradación HONESTA.
 *   - 3 certs presentes → mTLS (SSL creds, server + client).
 *   - sin certs         → insecure (caso dev/test: TODO sigue verde).
 *   - ruta rota         → fail-fast tipado (ValidationError).
 *   - config parcial    → fail-fast tipado.
 *   - endurecido + sin certs → WARN de boot (spy del logger), pero NO falla.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@veo/utils';
import {
  buildGrpcClientCredentials,
  buildGrpcServerCredentials,
  grpcTlsPathsFromEnv,
  grpcTlsRequiredFromEnv,
  resetGrpcTlsWarnLatchForTests,
  type GrpcTlsLogger,
  type GrpcTlsPaths,
} from './grpc-tls.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

// Cert + key auto-firmados de USAR-Y-TIRAR (NO secretos): solo para que `credentials.createSsl` /
// `ServerCredentials.createSsl` parseen un DER válido en construcción. La CA de confianza es el mismo
// cert (raíz auto-firmada). Generados con `openssl req -x509 -newkey rsa:2048 -nodes`.
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUQyZMGFqMT6WzDgejhSBOLCgM2XMwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNdmVvLWdycGMtdGVzdDAeFw0yNjA2MjYxNzI0MjFaFw0z
NjA2MjMxNzI0MjFaMBgxFjAUBgNVBAMMDXZlby1ncnBjLXRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCqCUDtuBn8YbL8AHV3HCTcoFMblKvc+d3c
i79sa9dlIMYQSf/rqFT6I0HtDcVWLahvCmFJ00JYLTfFhpbYr4EZDlcNsfRpbbZm
RJpXEoEHpGCmbGLnZzQr/NvDJi1vI9DWn3lbcfxKX4KyBua+4XvstOGib2QnTZqZ
8nk63PGmfsC/8O/mDjuaZyK3e9Q/in7uzjyOEs0gZSNWBFsoUZez9dcDqFDxtTDQ
AzaLn4mpu9+PxVL6W/mS8J3KR1MeLKa6gVUitWIIljzfyk1HRStWAo6ZcKx+3M0A
TCy51hL4ZtVK52yv3HDtXbFnN04XDLQIpojMPoMrgdtFMcrtb51DAgMBAAGjUzBR
MB0GA1UdDgQWBBSzwYPmOsaf91HuqmburXLBFCYLHDAfBgNVHSMEGDAWgBSzwYPm
Osaf91HuqmburXLBFCYLHDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQA088YuBNogQ3yzy2fQmon0hXA9HhCjXECWIstO++cuFsLd6EQixEC1VfRO
vcs4fZTIzTUn7uOIDf2OzI4UK8J5W5zxJPUCkBN1OVJf082cqQUCQOm0asNF2g3e
yVqd+EW/ZHGcSRBTaCM2ij/EUzKXGmXhQlsX0oisd5yNrZjmwnLbdtYJt7J4Qo3P
krQqIiCqPdy2e7XVMV7U12XddOXNfRWuBBHRuQMwq+555J3IYCQDOfCRWOjYxEWj
TMa9AsimOjejDDnNIIrhgaoGjgjOdM/++BX8Fbrhs7jl3dN4OYdyni1F092qcIJp
u1tXHXbfhrD4kz75Qu6L9zpk+NDS
-----END CERTIFICATE-----
`;
const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCqCUDtuBn8YbL8
AHV3HCTcoFMblKvc+d3ci79sa9dlIMYQSf/rqFT6I0HtDcVWLahvCmFJ00JYLTfF
hpbYr4EZDlcNsfRpbbZmRJpXEoEHpGCmbGLnZzQr/NvDJi1vI9DWn3lbcfxKX4Ky
Bua+4XvstOGib2QnTZqZ8nk63PGmfsC/8O/mDjuaZyK3e9Q/in7uzjyOEs0gZSNW
BFsoUZez9dcDqFDxtTDQAzaLn4mpu9+PxVL6W/mS8J3KR1MeLKa6gVUitWIIljzf
yk1HRStWAo6ZcKx+3M0ATCy51hL4ZtVK52yv3HDtXbFnN04XDLQIpojMPoMrgdtF
Mcrtb51DAgMBAAECggEATyQ6d8rKMYmpvJhcFCHh2Fy5AevbaGFWTeovoT+6hAPS
nE9NEjsJvlk9vJ+9u0RKEtDignGVfiQhwsrHmDhr3qUpiKLM72tUy9nfemqO6ucr
4xosmKcVBepNwVGaMRIbCGI2ooT12AoHc2Q57xtVSlHQeYHePFrm/AN7QJYI1aSD
B82h7WJslcTEtMTFb+yxlGxlQfiSkim67PaPLxwupdrgBlzIq8uCMScOyiVBbqWc
ZrY8RzeMo5dTPNXDmtbCno2pwu9Vwck9yQhYt6z6pmfdv5W2iKPQ/MKyC/F5FDPf
9lOWBvKyTjzW6cGkoqYriJtPPSpKp3E8UYyz9dFVHQKBgQDp176b07K+KzSeM33q
b01sRX6hrm7glMI6HYQOBJj5kQNlEIf7IT8Etp3lN975CkneXxg2f28w/5TTufRw
0aeVhWwOBDB1xPH5iN5YzzziFqq4pHfkqPXLlbnexrwZvHRsTHRPcJnDUafVOE1A
VnzNHQFVTLSBR4Km479rzTXCHQKBgQC6JcVWaKvMQUIU6pGx3QLFMqMmjP4b9xZC
vd2/BALkqIAmIUuBfxp40VTnCOHspJs5Ug5gP/X4Y/3f7MGk7ICoRgeEBLc64ksI
mjuDeOuaIpcgWShH8q+Fk4M+7QiVi/yDZ0Ri2qMPOMMH4/b6osh1GW+d0YvDT2Rm
IP4KBZK+3wKBgE2+0fuC9dFuEe9rFTkFSktuC3z7vpdiPfUObSIv+yA2S1elmGAx
HH+Xq4VS/wnzlr2dBjLQSYqT3spJ7/A2dC4tDtDWKbpuATlCfRIvzIEqohYDcG0Q
k6/dFs/vaQhxdI+xF5Z1zFl444DrWBvE5XdYZmISv4yf1ttfqvvPXUktAoGBAIjC
eUIrspRlGXyufY4UVxW0R0NqcMLw/KzaO5E8DDgcR9I7wfKJBFThTqRS1VF7+gLZ
82/pbfgo1ntuwTI/A6MdmCX5JPkhColubuz/qPDcGvYMKtj5RtU3dESF9zmP2Fxe
QVLzWLs1M6yXYnvvnqDRqDxlmG5M5PFXqeyI/bA3AoGAS5dEKP+bCYQzabC1Xtw3
u4JWoEPG8j3oSjUffHRa8n6FovFxCb6uQul2igvPSR1vtaNTLFtKrbng6GMZs0Ji
cOHgS4ZiwrRlv1Ay10JPHCbYzrrW6z6rzKZCNrU19EMy1pIJKEn6L1AYBurMRM3L
b8axcfXyK81R+r0zDZIEAx0=
-----END PRIVATE KEY-----
`;

function makeLogger(): GrpcTlsLogger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

describe('grpc-tls — degradación honesta', () => {
  let dir: string;
  let certs: GrpcTlsPaths;

  beforeEach(() => {
    // El WARN "mTLS no configurado" tiene latch once-per-process: reseteo entre tests para aislarlos.
    resetGrpcTlsWarnLatchForTests();
    // Fixtures de cert REALES (self-signed usar-y-tirar): el client `credentials.createSsl` parsea el
    // cert en construcción (asn1), así que un PEM trucho no sirve — necesita DER válido.
    dir = mkdtempSync(join(tmpdir(), 'veo-grpc-tls-'));
    const ca = join(dir, 'ca.pem');
    const cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    writeFileSync(ca, TEST_CERT_PEM);
    writeFileSync(cert, TEST_CERT_PEM);
    writeFileSync(key, TEST_KEY_PEM);
    certs = { caPath: ca, certPath: cert, keyPath: key };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    vi.restoreAllMocks();
  });

  describe('3 certs presentes → mTLS', () => {
    it('server credentials son SEGURAS', () => {
      const logger = makeLogger();
      const creds = buildGrpcServerCredentials(certs, logger);
      expect(creds._isSecure()).toBe(true);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('client credentials son SEGURAS', () => {
      const creds = buildGrpcClientCredentials(certs, makeLogger());
      expect(creds._isSecure()).toBe(true);
    });
  });

  describe('sin certs → insecure (dev/test no se rompe)', () => {
    const empty: GrpcTlsPaths = {};

    it('server credentials son INSECURE', () => {
      const creds = buildGrpcServerCredentials(empty, makeLogger());
      expect(creds._isSecure()).toBe(false);
    });

    it('client credentials son INSECURE', () => {
      const creds = buildGrpcClientCredentials(empty, makeLogger());
      expect(creds._isSecure()).toBe(false);
    });

    it('en entorno NO endurecido (dev/test) NO emite WARN', () => {
      process.env.NODE_ENV = 'development';
      const logger = makeLogger();
      buildGrpcServerCredentials(empty, logger);
      buildGrpcClientCredentials(empty, logger);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('endurecido (prod) + sin certs → WARN honesto, sin fallar', () => {
    it('emite el WARN de boot y degrada a insecure', () => {
      process.env.NODE_ENV = 'production';
      const logger = makeLogger();
      const creds = buildGrpcServerCredentials({}, logger);
      expect(creds._isSecure()).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0]?.[0]).toMatch(/mTLS NO configurado/);
      expect(logger.warn.mock.calls[0]?.[0]).toMatch(/TEXTO PLANO/);
    });

    it('el WARN se emite UNA vez por proceso aunque se construyan N clientes', () => {
      // MEDIA 2: un BFF arma ~12 clientes; el WARN de "no configurado" NO debe spamear N veces.
      process.env.NODE_ENV = 'production';
      const logger = makeLogger();
      for (let i = 0; i < 12; i++) buildGrpcClientCredentials({}, logger);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('GRPC_TLS_REQUIRED — lever de enforcement (MEDIA 1)', () => {
    it('required=true + sin certs → fail-fast (NO arranca en texto plano)', () => {
      // El 3er arg `required=true` simula GRPC_TLS_REQUIRED=true. Fail-fast SIEMPRE (no dedupe).
      expect(() => buildGrpcServerCredentials({}, makeLogger(), true)).toThrow(ValidationError);
      expect(() => buildGrpcClientCredentials({}, makeLogger(), true)).toThrow(/REQUERIDO/);
    });

    it('required=true + 3 certs → mTLS OK (arranca cifrado)', () => {
      const server = buildGrpcServerCredentials(certs, makeLogger(), true);
      const client = buildGrpcClientCredentials(certs, makeLogger(), true);
      expect(server._isSecure()).toBe(true);
      expect(client._isSecure()).toBe(true);
    });

    it('required=true NO emite WARN (no degrada — lanza)', () => {
      process.env.NODE_ENV = 'production';
      const logger = makeLogger();
      expect(() => buildGrpcServerCredentials({}, logger, true)).toThrow(ValidationError);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('grpcTlsRequiredFromEnv lee la var como boolean tipado', () => {
      expect(grpcTlsRequiredFromEnv({ GRPC_TLS_REQUIRED: 'true' })).toBe(true);
      expect(grpcTlsRequiredFromEnv({ GRPC_TLS_REQUIRED: 'false' })).toBe(false);
      expect(grpcTlsRequiredFromEnv({})).toBe(false);
    });
  });

  describe('fail-fast tipado', () => {
    it('ruta presente pero archivo inexistente → ValidationError', () => {
      const broken: GrpcTlsPaths = {
        caPath: join(dir, 'no-existe-ca.pem'),
        certPath: certs.certPath,
        keyPath: certs.keyPath,
      };
      expect(() => buildGrpcServerCredentials(broken, makeLogger())).toThrow(ValidationError);
      expect(() => buildGrpcClientCredentials(broken, makeLogger())).toThrow(/no se pudo leer/i);
    });

    it('config PARCIAL (1-2 de 3 rutas) → ValidationError, no degrada en silencio', () => {
      const partial: GrpcTlsPaths = { caPath: certs.caPath };
      expect(() => buildGrpcServerCredentials(partial, makeLogger())).toThrow(ValidationError);
      expect(() => buildGrpcClientCredentials(partial, makeLogger())).toThrow(/PARCIAL/);
    });
  });

  describe('grpcTlsPathsFromEnv', () => {
    it('lee las 3 vars GRPC_TLS_* de la fuente provista', () => {
      const paths = grpcTlsPathsFromEnv({
        GRPC_TLS_CA_PATH: '/c/ca.pem',
        GRPC_TLS_CERT_PATH: '/c/cert.pem',
        GRPC_TLS_KEY_PATH: '/c/key.pem',
      });
      expect(paths).toEqual({
        caPath: '/c/ca.pem',
        certPath: '/c/cert.pem',
        keyPath: '/c/key.pem',
      });
    });

    it('ausentes → undefined (insecure)', () => {
      expect(grpcTlsPathsFromEnv({})).toEqual({
        caPath: undefined,
        certPath: undefined,
        keyPath: undefined,
      });
    });
  });
});
