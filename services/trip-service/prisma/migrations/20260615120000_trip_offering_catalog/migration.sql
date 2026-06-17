-- CreateTable
CREATE TABLE "trip"."offering_catalog" (
    "id" TEXT NOT NULL,
    "overrides" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "offering_catalog_pkey" PRIMARY KEY ("id")
);
