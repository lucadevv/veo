'use client';

import { Ban, RotateCcw, KeyRound } from 'lucide-react';
import { DriverStatus, SuspensionCause } from '@veo/shared-types';
import type { DriverApproval } from '@/lib/api/schemas';
import {
  useDriverSuspend,
  useReactivateDriver,
  useReactivateDriverForCompliance,
} from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { StepUpDialog } from '@/components/security/step-up-dialog';

/** Etiqueta legible de cada causa del modelo de holds (`suspensionCauses` llega tipada del backend). */
const CAUSE_LABEL: Record<SuspensionCause, string> = {
  [SuspensionCause.DISCIPLINARY]: 'disciplinaria',
  [SuspensionCause.DOCUMENT_EXPIRED]: 'documentos vencidos',
  [SuspensionCause.INSPECTION_EXPIRED]: 'inspección técnica (ITV) vencida',
  [SuspensionCause.RATING_LOW]: 'rating bajo',
  [SuspensionCause.EXCESSIVE_CANCELLATIONS]: 'exceso de cancelaciones',
  [SuspensionCause.CATEGORY_DISABLED]: 'clase de servicio desactivada del catálogo',
};

/**
 * Toda causa que NO sea DISCIPLINARY se levanta por el override de compliance (documentos, ITV, rating y
 * futuros causes automáticos) — espeja `reactivateForCompliance` server-side, que quita todo hold
 * `cause !== DISCIPLINARY`. La disciplinaria va por su propia vía (`/reactivate`).
 */
function isComplianceCause(cause: string): boolean {
  return cause !== SuspensionCause.DISCIPLINARY;
}

/**
 * Suspender / reactivar MANUALMENTE a un conductor (acciones de SAFETY). La suspensión lo saca de
 * circulación: identity-service registra un HOLD por causa y el `suspendedAt` DERIVADO (gate de turno +
 * eligibility de dispatch, fail-closed) impide iniciar turno o aceptar ofertas. Un conductor puede estar
 * suspendido por VARIAS causas a la vez (modelo de holds): se libera solo cuando NO queda ninguna.
 *
 * Reactivar es CAUSE-AWARE: una suspensión DISCIPLINARIA se levanta con /reactivate; una por DOCUMENTOS o
 * ITV vencidos normalmente se reactiva sola al regularizar, y el override manual (/reactivate-compliance,
 * con step-up MFA) la fuerza. Si el conductor tiene ambas, se muestran ambas acciones. Todo gated por
 * `drivers:suspend`; el admin-bff revalida @Roles + (en el override) @RequireStepUpMfa server-side. La UI
 * no autoriza, solo refleja.
 */
export function ActiveDriverActions({ driver }: { driver: DriverApproval }) {
  const user = useSession();
  const { toast } = useToast();
  const suspend = useDriverSuspend();
  const reactivate = useReactivateDriver();
  const reactivateCompliance = useReactivateDriverForCompliance();

  if (!can(user, 'drivers:suspend')) {
    return <span className="text-xs text-ink-subtle">—</span>;
  }

  if (driver.status === DriverStatus.SUSPENDED) {
    const causes = driver.suspensionCauses;
    const hasDisciplinary = causes.includes(SuspensionCause.DISCIPLINARY);
    const hasCompliance = causes.some(isComplianceCause);
    // Defensivo: si la lista no trajo causas (carrera/legacy), ofrecemos AMBAS vías — el server es
    // fail-closed y rechaza la que no corresponda, así el operador nunca queda sin salida.
    const unknown = !hasDisciplinary && !hasCompliance;
    const showDisciplinary = hasDisciplinary || unknown;
    const showCompliance = hasCompliance || unknown;
    const dual = showDisciplinary && showCompliance;
    const complianceLabel = causes
      .filter(isComplianceCause)
      .map((c) => CAUSE_LABEL[c as SuspensionCause])
      .join(' y ');

    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {showDisciplinary && (
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="secondary">
                <RotateCcw className="size-4" aria-hidden />
                {dual ? 'Reactivar (disciplinaria)' : 'Reactivar'}
              </Button>
            }
            title="Reactivar suspensión disciplinaria"
            description={
              `Se levanta la suspensión DISCIPLINARIA del conductor ${driver.id.slice(0, 8)}. No afecta ` +
              'suspensiones por documentos o ITV vencidos (esas se levantan al regularizar o con el override ' +
              'de compliance). El conductor deberá pasar el gate biométrico al iniciar turno. Queda auditado.'
            }
            confirmLabel="Reactivar"
            variant="primary"
            onConfirm={async () => {
              await reactivate.mutateAsync({ id: driver.id });
              toast({ tone: 'success', title: 'Suspensión disciplinaria levantada' });
            }}
          />
        )}
        {showCompliance && (
          <StepUpDialog
            trigger={
              <Button size="sm" variant="secondary">
                <KeyRound className="size-4" aria-hidden />
                {dual ? 'Reactivar (docs/ITV)' : 'Reactivar'}
              </Button>
            }
            title="Override de compliance (documentos / ITV / rating)"
            description={
              `Forzás el levantamiento de la suspensión automática por ${complianceLabel || 'documentos/ITV/rating'} ` +
              `del conductor ${driver.id.slice(0, 8)}. Las suspensiones por documentos o ITV se reactivan solas ` +
              'al regularizar; la de rating bajo la levantás vos cuando corresponda. Usá este override solo si ' +
              'verificaste que la condición se resolvió. Ingresá tu código TOTP; la acción queda auditada.'
            }
            onVerified={async () => {
              await reactivateCompliance.mutateAsync({ id: driver.id });
              toast({ tone: 'success', title: 'Suspensión por documentos/ITV levantada' });
            }}
          />
        )}
      </div>
    );
  }

  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="secondary">
          <Ban className="size-4" aria-hidden />
          Suspender
        </Button>
      }
      title="Suspender conductor"
      description={`Se suspenderá al conductor ${driver.id.slice(0, 8)}. No podrá iniciar turno ni aceptar viajes hasta reactivarlo. La acción queda auditada.`}
      confirmLabel="Suspender"
      variant="danger"
      withReason
      reasonLabel="Motivo de la suspensión (queda auditado)"
      onConfirm={async (reason) => {
        await suspend.mutateAsync({ id: driver.id, reason: reason ?? '' });
        toast({ tone: 'success', title: 'Conductor suspendido' });
      }}
    />
  );
}
