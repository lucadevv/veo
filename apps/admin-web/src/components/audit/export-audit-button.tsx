'use client';

import { Download } from 'lucide-react';
import { BFF_PROXY_BASE } from '@/lib/config';
import { FILTER_ALL } from '@/lib/filters';
import { Button } from '@/components/ui/button';
import type { AuditFilters } from '@/lib/api/queries';

/**
 * Exporta el SET COMPLETO del filtro vigente (categoría + rango de fecha + búsqueda) a CSV. Espeja el patrón del
 * export de finanzas: el corte es SERVER-SIDE (el bff exporta todo el filtro, no la página cargada), DESCARGA
 * DIRECTA por el proxy same-origin (`/api/bff`) — el navegador adjunta la cookie httpOnly y el proxy la convierte
 * en Bearer; el atributo `download` de un <a> fuerza la descarga del `text/csv`. `category === ALL` y los vacíos
 * se OMITEN del query (igual que cleanQuery/useAudit) → el server exporta el set completo del filtro activo.
 */
export function ExportAuditButton({ filters }: { filters: AuditFilters }) {
  const download = () => {
    const params = new URLSearchParams();
    if (filters.category && filters.category !== FILTER_ALL) params.set('category', filters.category);
    if (filters.q) params.set('q', filters.q);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    const qs = params.toString();
    const href = `${BFF_PROXY_BASE}/audit/export${qs ? `?${qs}` : ''}`;
    const a = document.createElement('a');
    a.href = href;
    a.download = 'auditoria-export.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Button variant="secondary" size="sm" onClick={download}>
      <Download className="size-4" aria-hidden />
      Exportar registro
    </Button>
  );
}
