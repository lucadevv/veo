'use client';

import { useEffect } from 'react';
import { StateScreen } from '@/components/tracking/state-screen';
import { Button } from '@/components/ui/button';
import { RotateCw } from 'lucide-react';

/** Frontera de error global: muestra un estado tranquilo y permite reintentar. */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error('family-web error boundary', error);
  }, [error]);

  return (
    <StateScreen
      variant="unavailable"
      action={
        <Button variant="secondary" onClick={reset}>
          <RotateCw className="size-5" aria-hidden />
          Intentar de nuevo
        </Button>
      }
    />
  );
}
