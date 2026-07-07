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
}

main()
  .catch((err) => {
    console.error('Seed falló', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
