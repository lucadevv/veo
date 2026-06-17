/**
 * Seed de plantillas i18n por defecto (es-PE). Idempotente (upsert por key).
 * Uso: pnpm --filter @veo/notification-service db:seed
 */
import { PrismaClient } from '../src/generated/prisma';
import { DEFAULT_TEMPLATES } from '../src/engine/template.catalog';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    for (const t of DEFAULT_TEMPLATES) {
      await prisma.template.upsert({
        where: { key: t.key },
        update: { channel: t.channel, locale: t.locale, subject: t.subject, body: t.body },
        create: {
          key: t.key,
          channel: t.channel,
          locale: t.locale,
          subject: t.subject,
          body: t.body,
        },
      });
    }
    // eslint-disable-next-line no-console
    console.log(`Seed OK: ${DEFAULT_TEMPLATES.length} plantillas`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Seed falló', err);
  process.exit(1);
});
