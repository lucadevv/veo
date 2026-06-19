'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { Car, Check, Lock, Trash2 } from 'lucide-react';
import { ApiError } from '@veo/api-client';
import { useDriverDetail, useDriverDecision, useDeleteDriver } from '@/lib/api/queries';
import { dateTime } from '@/lib/formatters';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { StepUpDialog } from '@/components/security/step-up-dialog';
import { useToast } from '@/components/ui/toast';
import { DocumentViewer } from '@/components/drivers/document-viewer';

/**
 * Detalle de revisión de un conductor (GET /ops/drivers/:id): datos core + biométrico + VISOR de
 * documentos para aprobar/rechazar el onboarding. Vive DENTRO del grupo (dashboard) → hereda el layout
 * autenticado por JWT (ruta protegida). Espeja trips/[id]: `use(params)` + hook con cliente autenticado.
 * El bff además gatea esta ruta a Compliance+ (la UI refleja el permiso `drivers:view`).
 */
export default function DriverDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = use(props.params);
  const { id } = params;
  const user = useSession();
  const query = useDriverDetail(id);
  const driver = query.data;

  if (!can(user, 'drivers:view')) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          title="Conductor"
          breadcrumbs={[
            { label: 'Operación' },
            { label: 'Conductores', href: '/ops/drivers' },
            { label: id.slice(0, 8) },
          ]}
        />
        <EmptyState
          className="flex-1"
          icon={<Lock className="size-6" aria-hidden />}
          title="Acceso restringido"
          description="Necesitas el rol correspondiente para revisar a este conductor."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={driver?.fullName ?? `Conductor ${id.slice(0, 8)}`}
        breadcrumbs={[
          { label: 'Operación' },
          { label: 'Conductores', href: '/ops/drivers' },
          { label: id.slice(0, 8) },
        ]}
        actions={
          driver ? (
            <div className="flex items-center gap-3">
              <StatusPill status={driver.currentStatus} />
              <DeleteDriverAction driverId={driver.id} driverName={driver.fullName} />
            </div>
          ) : null
        }
      />

      {query.isLoading ? (
        <div className="grid gap-4 p-4 lg:grid-cols-2 lg:p-6">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} className="m-6" />
      ) : driver ? (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 lg:p-6">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Datos del conductor</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Detail label="Nombre" value={driver.fullName ?? '—'} />
                <Detail label="Teléfono" value={driver.phone ?? '—'} mono />
                <Detail label="DNI" value={driver.dni ?? '—'} mono />
                <Detail label="Fecha de nacimiento" value={driver.birthDate ?? '—'} />
                <Detail label="Licencia" value={driver.licenseNumber ?? '—'} mono />
                <Detail label="Alta" value={dateTime(driver.createdAt)} />
                <div>
                  <dt className="text-xs text-ink-muted">Antecedentes</dt>
                  <dd className="mt-1">
                    <StatusPill status={driver.backgroundCheckStatus} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">KYC</dt>
                  <dd className="mt-1">
                    <StatusPill status={driver.kycStatus} />
                  </dd>
                </div>
                {driver.rejectionReason ? (
                  <div className="col-span-2">
                    <dt className="text-xs text-ink-muted">Motivo del rechazo</dt>
                    <dd className="text-danger">{driver.rejectionReason}</dd>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Verificación biométrica</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Detail label="Rostro enrolado" value={dateTime(driver.biometric.faceEnrolledAt)} />
                <Detail
                  label="Última verificación"
                  value={dateTime(driver.biometric.lastVerifiedAt)}
                />
              </CardContent>
            </Card>
          </div>

          {/* Ficha del vehículo (F2 · C1): el operador ve QUÉ auto opera antes de aprobar. */}
          <Card>
            <CardHeader>
              <CardTitle>Vehículo</CardTitle>
            </CardHeader>
            <CardContent>
              {driver.vehicle ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                  <Detail label="Placa" value={driver.vehicle.plate} mono />
                  <Detail label="Marca" value={driver.vehicle.make || '—'} />
                  <Detail label="Modelo" value={driver.vehicle.model || '—'} />
                  <Detail label="Año" value={String(driver.vehicle.year)} />
                  <Detail label="Color" value={driver.vehicle.color || '—'} />
                  <Detail label="Tipo" value={driver.vehicle.vehicleType} />
                  <div>
                    <dt className="text-xs text-ink-muted">Documentación</dt>
                    <dd className="mt-1">
                      <StatusPill status={driver.vehicle.docStatus} />
                    </dd>
                  </div>
                </div>
              ) : (
                <EmptyState
                  icon={<Car className="size-6" aria-hidden />}
                  title="Sin vehículo registrado"
                  description="El conductor todavía no registró un vehículo."
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Documentos</CardTitle>
              <ApproveDriverAction driverId={driver.id} />
            </CardHeader>
            <CardContent>
              <DocumentViewer
                documents={driver.documents}
                isLoading={false}
                isError={false}
                onReload={() => void query.refetch()}
                isReloading={query.isFetching}
                driverId={driver.id}
              />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={mono ? 'font-mono text-ink tabular' : 'text-ink'}>{value}</dd>
    </div>
  );
}

/**
 * Aprobar al CONDUCTOR (POST /ops/drivers/:id/approve vía useDriverDecision). Gateado por
 * `drivers:approve` (la UI refleja; el bff revalida @Roles). El backend tiene un GATE autoritativo: si
 * los 3 documentos obligatorios no están VALID responde 409 (ConflictError) con un mensaje en español;
 * el ConfirmDialog captura el throw del mutateAsync y lo muestra como error amigable en el propio diálogo.
 */
function ApproveDriverAction({ driverId }: { driverId: string }) {
  const user = useSession();
  const { toast } = useToast();
  const decision = useDriverDecision();

  if (!can(user, 'drivers:approve')) {
    return null;
  }

  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="primary">
          <Check className="size-4" aria-hidden />
          Aprobar conductor
        </Button>
      }
      title="Aprobar conductor"
      description="Habilitas al conductor para operar. Requiere que los documentos obligatorios estén válidos; si falta alguno, el servidor lo rechazará y verás el detalle aquí."
      confirmLabel="Aprobar"
      onConfirm={async () => {
        await decision.mutateAsync({ id: driverId, decision: 'approve' });
        toast({ tone: 'success', title: 'Conductor aprobado' });
      }}
    />
  );
}

/**
 * Traduce el ApiError del borrado a un mensaje AMIGABLE para mostrar dentro del ConfirmDialog (irreversible).
 * - 409 (ConflictError, BR-S06): el conductor tiene historial operativo → el backend ya manda un texto
 *   amigable en español sobre el flujo de "derecho al olvido"; lo reusamos tal cual (no lo crudeamos).
 * - 403: rol insuficiente (no SUPERADMIN) o MFA no fresca → mensaje claro propio (el server no detalla por seguridad).
 * - Resto/red: fallback genérico.
 */
function friendlyDeleteError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return (
        error.message ||
        'Este conductor tiene historial operativo y no puede borrarse. Usá el flujo de derecho al olvido (BR-S06).'
      );
    }
    if (error.status === 403) {
      return 'No tenés permiso para borrar conductores, o tu verificación MFA no está fresca. Reautenticate e intentá de nuevo.';
    }
    return error.message || 'No se pudo eliminar al conductor.';
  }
  return 'No se pudo eliminar al conductor.';
}

/**
 * Eliminar al CONDUCTOR en cascada (DELETE /ops/drivers/:id vía useDeleteDriver). Acción IRREVERSIBLE,
 * visible SOLO a SUPERADMIN (gateada por `drivers:delete`; el bff revalida @Roles(SUPERADMIN) + step-up MFA).
 * El ConfirmDialog exige escribir el nombre del conductor (o "ELIMINAR" si no hay nombre) para habilitar el
 * botón de confirmar. On success: toast + redirect a /ops/drivers (la cache de drivers se invalida en el hook).
 * On error captura el throw del mutateAsync y lo muestra como mensaje amigable (409 BR-S06 / 403) en el diálogo.
 */
function DeleteDriverAction({
  driverId,
  driverName,
}: {
  driverId: string;
  driverName: string | null;
}) {
  const user = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const remove = useDeleteDriver();

  if (!can(user, 'drivers:delete')) {
    return null;
  }

  const who = driverName?.trim() ? driverName.trim() : 'este conductor';

  // Eliminar es acción sensible → exige step-up MFA (el bff tiene @RequireStepUpMfa). El StepUpDialog
  // pide el TOTP, llama /auth/step-up (eleva la MFA) y SOLO entonces ejecuta el borrado. El TOTP es la
  // confirmación fuerte e irreversible (mismo patrón que video/live). El diálogo se cierra antes de
  // onVerified, así que el resultado del borrado se reporta por toast (no inline).
  return (
    <StepUpDialog
      trigger={
        <Button size="sm" variant="danger">
          <Trash2 className="size-4" aria-hidden />
          Eliminar conductor
        </Button>
      }
      title="Eliminar conductor"
      description={`Vas a borrar a ${who}: su usuario, documentos y archivos en cascada. Es IRREVERSIBLE. Ingresá tu código TOTP para confirmar.`}
      onVerified={async () => {
        try {
          await remove.mutateAsync({ id: driverId });
          toast({ tone: 'success', title: 'Conductor eliminado' });
          router.push('/ops/drivers');
        } catch (error) {
          toast({ tone: 'danger', title: 'No se pudo eliminar', description: friendlyDeleteError(error) });
        }
      }}
    />
  );
}
