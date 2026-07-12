'use client';

import { use } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useSession } from '@/lib/session-context';
import { can } from '@/lib/rbac';
import { PermissionState } from '@/components/ui/states';
import { PayoutDetailView } from '@/components/finance/payout-detail-view';

/**
 * Página-detalle de una liquidación (frame veo.pen `t5eZt`): ruta rica que reemplaza al modal de auditoría.
 * Gate de presentación `finance:view` (la autoridad real es el admin-bff); sin permiso → 403 fiel al board.
 */
export default function PayoutDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = use(props.params);
  const user = useSession();

  if (!can(user, 'finance:view')) {
    return (
      <div className="flex h-full flex-col">
        <header className="sticky top-0 z-sticky flex items-center gap-3.5 border-b border-[color:var(--divider)] bg-surface px-7 py-4">
          <Link
            href="/finance"
            aria-label="Volver a Liquidaciones"
            className="grid size-[38px] shrink-0 place-items-center rounded-[10px] border border-border bg-bg text-ink-muted transition-colors hover:bg-surface-2"
          >
            <ArrowLeft className="size-[17px]" aria-hidden />
          </Link>
          <h1 className="font-display text-[21px] font-bold tracking-[-0.4px] text-ink">Liquidación</h1>
        </header>
        <PermissionState className="flex-1" section="Liquidaciones" permission="finance:view" />
      </div>
    );
  }

  return <PayoutDetailView payoutId={id} />;
}
