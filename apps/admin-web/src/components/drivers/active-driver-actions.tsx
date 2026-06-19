'use client';

import { Ban, RotateCcw } from 'lucide-react';
import { DriverStatus } from '@veo/shared-types';
import type { DriverApproval } from '@/lib/api/schemas';
import { useDriverSuspend, useReactivateDriver } from '@/lib/api/queries';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * Suspender / reactivar MANUALMENTE a un conductor de la flota (acciones de SAFETY). Suspender saca al
 * conductor de circulación: identity-service escribe `suspendedAt`, y el gate de turno (startShift) + el
 * eligibility gate de dispatch (ya existentes, fail-closed) impiden que inicie turno o acepte ofertas. La
 * suspensión lleva MOTIVO obligatorio que queda auditado. Reactivar es la INVERSA, pero FAIL-CLOSED: solo
 * levanta suspensiones DISCIPLINARIAS (las que originó un operador); el server rechaza con 403 si la
 * suspensión era por documentos vencidos (esa se levanta cuando el conductor regulariza sus documentos).
 * Ambas gated por `drivers:suspend` (suspender y reactivar comparten RBAC); el admin-bff revalida
 * @Roles(COMPLIANCE_SUPERVISOR/ADMIN/SUPERADMIN) server-side (la UI no autoriza).
 */
export function ActiveDriverActions({ driver }: { driver: DriverApproval }) {
  const user = useSession();
  const { toast } = useToast();
  const suspend = useDriverSuspend();
  const reactivate = useReactivateDriver();

  if (!can(user, 'drivers:suspend')) {
    return <span className="text-xs text-ink-subtle">—</span>;
  }

  // Suspendido: ofrecemos la REACTIVACIÓN (la inversa). El server decide fail-closed si procede (solo
  // suspensiones disciplinarias; 403 si era por documentos vencidos), y el ConfirmDialog muestra ese error.
  if (driver.status === DriverStatus.SUSPENDED) {
    return (
      <ConfirmDialog
        trigger={
          <Button size="sm" variant="secondary">
            <RotateCcw className="size-4" aria-hidden />
            Reactivar
          </Button>
        }
        title="Reactivar conductor"
        description={
          `Se reactivará al conductor ${driver.id.slice(0, 8)}. Solo funciona para suspensiones ` +
          'disciplinarias (las que originó un operador): si la suspensión fue por documentos vencidos, ' +
          'el servidor la rechazará (debe regularizar sus documentos). Reactivar NO devuelve al conductor ' +
          'a circulación por sí solo: deberá pasar el gate biométrico al iniciar turno. La acción queda auditada.'
        }
        confirmLabel="Reactivar"
        variant="primary"
        onConfirm={async () => {
          await reactivate.mutateAsync({ id: driver.id });
          toast({ tone: 'success', title: 'Conductor reactivado' });
        }}
      />
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
