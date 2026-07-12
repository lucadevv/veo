'use client';

import { useState } from 'react';
import type { CostPerKmListView } from '@/lib/api/schemas';
import { useReplaceCostPerKm } from '@/lib/api/queries';
import { can } from '@/lib/rbac';
import { useSession } from '@/lib/session-context';
import { parseSolesInput, formatSolesInput } from '@/lib/money';
import { useConfigSave } from '@/lib/use-config-save';
import { SaveAction, ReadOnlyNote } from '@/components/config/save-action';
import { ConfigCard, RateField, RateInput } from '@/components/config/config-card';
import { PriceDiffHint } from '@/components/config/price-diff-hint';

/** Formato del hint LIVE-DIFF (money): céntimos → "S/1.35" (mismo `formatSolesInput` que el sub "Actual"). */
const moneyLabel = (cents: number) => `S/${formatSolesInput(cents)}`;

/** Tope de cordura del costo/km (espejo del DTO server-side, defensa en profundidad UI): S/0.01 .. S/100/km. */
const MIN_CENTS = 1;
const MAX_CENTS = 10_000;

/** Etiqueta legible del país. */
const PAIS_LABEL: Record<string, string> = { PE: 'Perú (PEN)', EC: 'Ecuador (USD→PEN ref.)' };

/**
 * Costo de OPERACIÓN por km del carpooling (F2.5 · escudo legal anti-lucro) — card del diseño (veo.pen). El admin
 * fija, por país, el costo real de operar el vehículo (combustible + desgaste, estilo "IRS mileage rate"). Ese
 * costo/km alimenta DIRECTO el tope de cost-sharing: precio del asiento ≤ (distancia_km × costo/km + peaje) /
 * asientos. NO se deriva del precio de energía. El peaje lo declara el conductor por viaje (no se configura acá).
 * La UI solo refleja `finance:manage`; el admin-bff + booking-service re-autorizan y auditan.
 *
 * Diseño (veo.pen): UNA card con una fila por país y UN "Guardar sección". Cada país versiona su tarifa por
 * separado (CAS independiente), así que el guardado unificado es EXACTAMENTE el patrón `saveRow` del catálogo:
 * un solo botón que dispara N writes SECUENCIALES (uno por país DIRTY), cada uno con SU propio `expectedVersion`,
 * y con SHORT-CIRCUIT — si un país falla (409/error) NO se sigue con el resto (config de dinero, sin mezclas).
 */
export function CostPerKmPanel({ config }: { config: CostPerKmListView }) {
  const canManage = can(useSession(), 'finance:manage');
  const replace = useReplaceCostPerKm();
  // Una sola mutation para todos los países (mismo endpoint PUT /finance/cost-per-km, discriminado por `pais`);
  // el CAS lo lleva CADA write con su propio `expectedVersion`. Reusa el toast (éxito/409→info/error) de siempre;
  // el título de éxito se pasa por-llamada (lleva el país) vía successOverride, igual que el catálogo.
  const { save, saving } = useConfigSave({
    mutation: replace,
    conflictNoun: 'el costo/km',
    error: 'No se pudo guardar el costo/km',
  });

  // Draft por país (pais → soles). Se siembra una vez desde la config cargada; tras un save el onSettled
  // re-sincroniza la query y `dirty` cae solo (cents === el valor vigente), sin re-montar la card.
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(config.configs.map((c) => [c.pais, formatSolesInput(c.costPerKmCents)])),
  );
  const setDraft = (pais: string, value: string) =>
    setDrafts((prev) => ({ ...prev, [pais]: value }));

  // Estado derivado por país: valor tipeado, céntimos parseados, validez y dirtiness (cada país usa SU versión).
  const rows = config.configs.map((c) => {
    const soles = drafts[c.pais] ?? formatSolesInput(c.costPerKmCents);
    const cents = parseSolesInput(soles);
    const invalid = !Number.isInteger(cents) || cents < MIN_CENTS || cents > MAX_CENTS;
    const dirty = cents !== c.costPerKmCents;
    return { config: c, soles, cents, invalid, dirty };
  });

  const anyDirty = rows.some((r) => r.dirty);
  const anyInvalid = rows.some((r) => r.invalid);

  // UN solo Guardar: escribe SOLO los países que cambiaron, en secuencia, cada uno con su CAS per-país. Patrón
  // `saveRow` del catálogo: short-circuit al primer 409/error (config de dinero, N writes secuenciales no deben
  // dejar una mezcla inconsistente). El toast por-write lo maneja useConfigSave (éxito/409/error).
  async function onSave() {
    for (const r of rows) {
      if (!r.dirty) continue;
      const ok = await save(
        { pais: r.config.pais, costPerKmCents: r.cents, expectedVersion: r.config.version },
        `Costo/km ${r.config.pais}: S/${formatSolesInput(r.cents)}`,
      );
      if (!ok) return;
    }
  }

  const hasCountries = config.configs.length > 0;

  return (
    <ConfigCard
      title="Costo por km · tope de cost-sharing"
      tag="por país"
      tagTone="success"
      description="El costo real de operar el vehículo por km (combustible + desgaste). Limita el precio del carpooling: el asiento no puede pasar de (distancia × costo/km + peaje) ÷ asientos. El peaje lo declara el conductor por viaje."
      footer={
        hasCountries ? (
          <SaveAction
            canManage={canManage}
            dirty={anyDirty}
            invalid={anyInvalid}
            saving={saving}
            onSave={onSave}
            title="Confirmar costo/km del carpooling"
            description="Esta acción cambia el costo de operación por km que limita el precio del carpooling (escudo legal anti-lucro) y queda auditada."
          />
        ) : undefined
      }
    >
      {hasCountries ? (
        rows.map((r) => (
          <RateField
            key={r.config.pais}
            label={PAIS_LABEL[r.config.pais] ?? r.config.pais}
            sub={`Actual: S/${formatSolesInput(r.config.costPerKmCents)}/km`}
            unit="S/·km"
            error={
              r.invalid
                ? `Entre S/${formatSolesInput(MIN_CENTS)} y S/${formatSolesInput(MAX_CENTS)}`
                : undefined
            }
            hint={
              <PriceDiffHint before={r.config.costPerKmCents} after={r.cents} format={moneyLabel} />
            }
          >
            <RateInput
              type="number"
              inputMode="decimal"
              // step de 1 céntimo: el piso es S/0.01 (min), así que con step=0.10 el browser marcaba stepMismatch
              // (`:invalid`) para valores legítimos como 1.50/0.50 — no caen en la grilla 0.01+0.10·n. El costo/km
              // es dinero en céntimos: 0.01 es la granularidad natural y alinea min↔step (sin falso `invalid`).
              step="0.01"
              min={formatSolesInput(MIN_CENTS)}
              max={formatSolesInput(MAX_CENTS)}
              value={r.soles}
              onChange={(e) => setDraft(r.config.pais, e.target.value)}
              disabled={!canManage}
            />
          </RateField>
        ))
      ) : (
        <p className="text-sm text-ink-subtle">
          Sin costos de operación configurados todavía. Definí el costo por km por país para activar
          el techo anti-lucro del carpooling.
        </p>
      )}
      <ReadOnlyNote canManage={canManage} noun="el costo/km" />
    </ConfigCard>
  );
}
