-- CreateTable
CREATE TABLE "identity"."permission_overrides" (
    "role" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT true,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "permission_overrides_pkey" PRIMARY KEY ("role","permission")
);
