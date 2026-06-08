'use client';

import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Reintenta la carga recargando la vista actual (para el estado "no disponible"). */
export function RetryButton() {
  return (
    <Button variant="secondary" onClick={() => window.location.reload()}>
      <RotateCw className="size-5" aria-hidden />
      Intentar de nuevo
    </Button>
  );
}
