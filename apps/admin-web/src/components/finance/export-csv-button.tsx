'use client';

import { Download } from 'lucide-react';
import { BFF_PROXY_BASE } from '@/lib/config';
import { FILTER_ALL } from '@/lib/filters';
import { Button } from '@/components/ui/button';

/**
 * Exporta el SET COMPLETO del filtro Estado vigente a CSV (server-side: el bff exporta TODO el filtro, no la
 * página ya cargada). DESCARGA DIRECTA por el proxy same-origin (`/api/bff`): el navegador adjunta la cookie
 * httpOnly y el proxy la convierte en Bearer; el atributo `download` de un <a> same-origin fuerza la descarga
 * del `text/csv` que sirve el endpoint (no un hook de react-query — es una respuesta binaria, no JSON cacheable).
 * `status === ALL` se OMITE del query (igual que `cleanQuery`/`usePayouts`) → el server exporta todos.
 */
export function ExportCsvButton({ status }: { status: string }) {
  const download = () => {
    const params = new URLSearchParams();
    if (status && status !== FILTER_ALL) params.set('status', status);
    const qs = params.toString();
    const href = `${BFF_PROXY_BASE}/finance/payouts/export${qs ? `?${qs}` : ''}`;
    const a = document.createElement('a');
    a.href = href;
    a.download = 'payouts-export.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Button variant="primary" size="sm" onClick={download}>
      <Download className="size-4" aria-hidden />
      Exportar CSV
    </Button>
  );
}
