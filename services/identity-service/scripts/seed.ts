/**
 * Seed mínimo: crea el operador SUPERADMIN inicial (ACTIVE).
 * Uso: DATABASE_URL=... SEED_SUPERADMIN_EMAIL=... SEED_SUPERADMIN_PASSWORD=... pnpm db:seed
 *
 * TOTP: en entornos ENDURECIDOS (NODE_ENV=production — preview Y prod, ambos internet-facing) el admin
 * enrola en su primer login (secreto random). En DEV/local (NODE_ENV!=production) se pre-enrola con un
 * secreto FIJO conocido (DEV_TOTP_SECRET) para que el visor de OTPs (dev-stack/otp-viewer) muestre el
 * código vivo sin app de autenticación. La decisión usa NODE_ENV (igual que el secret() de @veo/utils):
 * el TIER de despliegue (preview vs prod) lo da el env_file, NO este flag.
 */
import argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma';
import { seal } from '../src/common/secret-box';

const prisma = new PrismaClient();

/**
 * Secreto TOTP FIJO de DEV (base32). DEBE coincidir EXACTO con DEV_ADMIN_TOTP_SECRET del visor
 * (dev-stack/otp-viewer/server.mjs) para que el código mostrado valide contra identity. Solo dev.
 */
const DEV_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/**
 * Operadores de DEV — un usuario ACTIVE por cada rol canónico (además del SUPERADMIN). Solo se crean en
 * entornos NO endurecidos (local/dev): sirven para probar cada vista por rol y los estados 403 del overlay
 * (ej. FINANCE no tiene `trips:view` → 403 en Viajes; SUPPORT_L1 no tiene `ops:view` → 403 en En Vivo/Métricas).
 * Comparten el TOTP fijo de dev → el código del visor :5190 valida para todos. JAMÁS se siembran en producción.
 */
const DEV_ROLE_USERS: readonly { email: string; role: string }[] = [
  { email: 'admin-role@veo.pe', role: 'ADMIN' },
  { email: 'dispatcher@veo.pe', role: 'DISPATCHER' },
  { email: 'support-l1@veo.pe', role: 'SUPPORT_L1' },
  { email: 'support-l2@veo.pe', role: 'SUPPORT_L2' },
  { email: 'compliance@veo.pe', role: 'COMPLIANCE_SUPERVISOR' },
  { email: 'finance@veo.pe', role: 'FINANCE' },
];

async function main(): Promise<void> {
  const email = process.env.SEED_SUPERADMIN_EMAIL ?? 'admin@veo.pe';
  const password = process.env.SEED_SUPERADMIN_PASSWORD ?? 'ChangeMe_VEO_2026!';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  // Endurecido = cualquier entorno internet-facing (NODE_ENV=production: preview Y prod). Solo el
  // local/dev (NODE_ENV development) pre-enrola el TOTP fijo para el visor.
  const isHardened = process.env.NODE_ENV === 'production';
  // En dev pre-enrolamos el TOTP con el secreto fijo (sellado igual que identity). Endurecido → null →
  // el admin enrola normal en el primer login (secreto random, jamás conocido).
  const totpFields = isHardened
    ? {}
    : {
        totpEnrolled: true,
        totpSecretEnc: seal(
          DEV_TOTP_SECRET,
          process.env.TOTP_ENC_KEY ?? 'dev-totp-enc-key-change-me',
        ),
      };

  const admin = await prisma.adminUser.upsert({
    where: { email },
    // El update preserva el TOTP de un admin ENDURECIDO (re-pisarlo desincronizaba el Authenticator real
    // del operador). Pero en DEV (no endurecido) NO hay Authenticator real: es el secreto FIJO del visor →
    // lo refrescamos también en el update para que el código del visor (:5190) SIEMPRE valide tras un
    // re-seed (mata el blocker "Código TOTP incorrecto" por secreto en formato/key viejos). Solo dev.
    update: { status: 'ACTIVE', roles: ['SUPERADMIN'], ...(isHardened ? {} : totpFields) },
    create: { email, passwordHash, roles: ['SUPERADMIN'], status: 'ACTIVE', ...totpFields },
  });

  console.warn(
    `SUPERADMIN listo: ${admin.email} (${admin.status}). ` +
      (isHardened
        ? 'Enrola TOTP en el primer login.'
        : 'TOTP pre-enrolado (dev) — código en el visor :5190.'),
  );

  // Operadores por rol: SOLO en dev (no endurecido). En producción jamás se crean — el superadmin invita
  // a los operadores reales por el flujo de la app (POST /operators → INVITED → aceptar → enrolar TOTP).
  if (isHardened) return;
  for (const u of DEV_ROLE_USERS) {
    await prisma.adminUser.upsert({
      where: { email: u.email },
      update: { status: 'ACTIVE', roles: [u.role], ...totpFields },
      create: { email: u.email, passwordHash, roles: [u.role], status: 'ACTIVE', ...totpFields },
    });
  }
  console.warn(
    `Operadores por rol (dev) listos: ${DEV_ROLE_USERS.map((u) => `${u.email}=${u.role}`).join(', ')}. ` +
      `Contraseña compartida = la del SUPERADMIN; TOTP del visor :5190.`,
  );
}

main()
  .catch((err) => {
    console.error('Seed falló', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
