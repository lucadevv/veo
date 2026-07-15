'use client';

import { useState } from 'react';
import { Download } from 'lucide-react';
import { BFF_PROXY_BASE } from '@/lib/config';
import { FILTER_ALL } from '@/lib/filters';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import type { AuditFilters } from '@/lib/api/queries';

/**
 * Exporta el SET COMPLETO del filtro vigente (categoría + rango de fecha + búsqueda) a CSV. El corte es
 * SERVER-SIDE (el bff exporta todo el filtro, no la página cargada). Descarga por FETCH same-origin (`/api/bff`,
 * `credentials: include` → el navegador adjunta la cookie httpOnly y el proxy la convierte en Bearer): a diferencia
 * de un `<a download>` crudo, si el server responde 403/500 NO se baja el cuerpo de error DISFRAZADO de CSV —
 * mostramos un toast de error. En 2xx materializamos el blob → object URL → click de un <a> con el filename fijo.
 * `category === ALL` y los vacíos se OMITEN del query (igual que cleanQuery/useAudit) → el server exporta el set
 * completo del filtro activo.
 */
export function ExportAuditButton({ filters }: { filters: AuditFilters }) {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    if (downloading) return;
    const params = new URLSearchParams();
    if (filters.category && filters.category !== FILTER_ALL) params.set('category', filters.category);
    if (filters.q) params.set('q', filters.q);
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
    const qs = params.toString();
    const href = `${BFF_PROXY_BASE}/audit/export${qs ? `?${qs}` : ''}`;

    setDownloading(true);
    try {
      const res = await fetch(href, { credentials: 'include' });
      if (!res.ok) {
        toast({
          tone: 'danger',
          title: 'No se pudo exportar el registro',
          description:
            res.status === 403
              ? 'No tenés permiso para exportar auditoría.'
              : `El servidor respondió ${res.status}. Intentá de nuevo en un momento.`,
        });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'auditoria-export.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast({
        tone: 'danger',
        title: 'No se pudo exportar el registro',
        description: e instanceof Error ? e.message : 'Revisá tu conexión e intentá de nuevo.',
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Button variant="secondary" size="sm" onClick={() => void download()} loading={downloading}>
      <Download className="size-4" aria-hidden />
      Exportar registro
    </Button>
  );
}
