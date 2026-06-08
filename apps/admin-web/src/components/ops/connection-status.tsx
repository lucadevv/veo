'use client';

import { useOpsStore } from '@/lib/realtime/ops-store';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { SocketStatus } from '@/lib/realtime/ops-socket';

const MAP: Record<SocketStatus, { label: string; tone: BadgeProps['tone'] }> = {
  idle: { label: 'Conectando…', tone: 'neutral' },
  connecting: { label: 'Conectando…', tone: 'neutral' },
  reconnecting: { label: 'Reconectando…', tone: 'warn' },
  connected: { label: 'En vivo', tone: 'success' },
  disconnected: { label: 'Sin conexión', tone: 'danger' },
};

/** Estado de la conexión de tiempo real /ops. */
export function ConnectionStatus() {
  const status = useOpsStore((s) => s.status);
  const { label, tone } = MAP[status];
  return (
    <Badge tone={tone}>
      <span
        className={`size-2 rounded-full ${
          tone === 'success' ? 'bg-success' : tone === 'danger' ? 'bg-danger' : 'bg-warn'
        } ${status === 'connected' ? 'animate-pulse' : ''}`}
        aria-hidden
      />
      {label}
    </Badge>
  );
}
