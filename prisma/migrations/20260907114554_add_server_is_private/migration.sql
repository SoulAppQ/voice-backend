-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MixerPreset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "targetIdentity" TEXT NOT NULL,
    "voice" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "stream" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "bassCut" INTEGER NOT NULL DEFAULT 90,
    "trebleCut" INTEGER NOT NULL DEFAULT 8000,
    "pan" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MixerPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NamedMixerPreset" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "presetData" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NamedMixerPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MixerPreset_ownerId_targetIdentity_key" ON "MixerPreset"("ownerId", "targetIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "NamedMixerPreset_ownerId_name_key" ON "NamedMixerPreset"("ownerId", "name");

-- AddForeignKey
ALTER TABLE "MixerPreset" ADD CONSTRAINT "MixerPreset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NamedMixerPreset" ADD CONSTRAINT "NamedMixerPreset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
