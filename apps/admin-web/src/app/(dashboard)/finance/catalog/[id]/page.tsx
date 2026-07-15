'use client';

import { use } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PermissionState } from '@/components/ui/states';
import { OfferingDetailView } from '@/components/catalog/offering-detail-view';

/**
 * Página-detalle de UNA oferta de servicio (frame veo.pen `HjDvx` · "Ofertas · Detalle"): config + tarifa +
 * disponibilidad + estado + métricas 30d + acciones (editar / pausar / auditar). El `[id]` de la ruta = el
 * offering id. Gate de presentación `catalog:view` (la autoridad real es el admin-bff + trip-service); sin
 * permiso → 403 fiel al board, con el mismo topbar de vuelta al catálogo.
 */
export default function OfferingDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const user = useSession();

  if (!can(user, 'catalog:view')) {
    return (
      <div className="flex h-full flex-col">
        <header className="sticky top-0 z-sticky flex items-center gap-3.5 border-b border-[color:var(--divider)] bg-surface px-7 py-4">
          <Link
            href="/finance/catalog"
            aria-label="Volver a Ofertas de servicio"
            className="grid size-[38px] shrink-0 place-items-center rounded-[10px] border border-border bg-bg text-ink-muted transition-colors hover:bg-surface-2"
          >
            <ArrowLeft className="size-[17px]" aria-hidden />
          </Link>
          <h1 className="font-display text-[21px] font-semibold tracking-[-0.4px] text-ink">Servicio</h1>
        </header>
        <PermissionState className="flex-1" section="Ofertas de servicio" permission="catalog:view" />
      </div>
    );
  }

  return <OfferingDetailView offeringId={id} />;
}
