-- ADR 011 · pricing_mode_schedule: SINGLETON de config del schedule de modo (Tier 1 GLOBAL).
-- Una sola fila (id fijo 'GLOBAL') que el ModeResolver lee para resolver PUJA|FIXED por horario en
-- hora LOCAL de Lima (UTC-5, sin DST). El PUT del admin la REEMPLAZA wholesale (rules+defaultMode
-- enteros, bump de version). Sin fila → el resolver degrada a defaultMode=PUJA con rules=[] (§8.2).
-- El schedule lo OWNE trip-service (admin-bff es stateless): co-locar evita un hop por createTrip (§3).
-- Ver trip-service/prisma/schema.prisma model PricingModeSchedule.

-- CreateTable
CREATE TABLE "trip"."pricing_mode_schedule" (
    "id" TEXT NOT NULL,
    "default_mode" "trip"."PricingMode" NOT NULL DEFAULT 'PUJA',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "pricing_mode_schedule_pkey" PRIMARY KEY ("id")
);
