'use client';

import { type KeyboardEvent, useState } from 'react';
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { TableSkeleton } from './skeleton';
import { EmptyState } from './states';

interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  onRowClick?: (row: TData) => void;
  /**
   * Etiqueta accesible por fila clickeable (a11y por teclado/lector). El DataTable es genérico y no
   * conoce el dominio, así que el caller describe la fila (ej. `Ver detalle del viaje #${row.id}`).
   * Solo aplica cuando hay `onRowClick`; sin ella la fila clickeable cae a un label genérico.
   */
  rowLabel?: (row: TData) => string;
  /** Etiqueta accesible de la tabla. */
  caption: string;
}

/** Tabla densa con orden (aria-sort), header sticky y números tabulares. */
export function DataTable<TData>({
  columns,
  data,
  loading = false,
  emptyTitle = 'Sin resultados',
  emptyDescription,
  onRowClick,
  rowLabel,
  caption,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (loading) return <TableSkeleton cols={columns.length} />;
  if (data.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-black/[0.05] bg-surface shadow-3">
      <table className="w-full border-collapse text-sm tabular">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-sticky bg-surface-2">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id} className="border-b border-border">
              {group.headers.map((header) => {
                const sortDir = header.column.getIsSorted();
                const canSort = header.column.getCanSort();
                return (
                  <th
                    key={header.id}
                    aria-sort={
                      sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : 'none'
                    }
                    className="px-4 py-3 text-left text-[11px] font-bold uppercase tracking-[0.06em] text-ink-subtle"
                  >
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="inline-flex items-center gap-1.5 hover:text-ink"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sortDir === 'asc' ? (
                          <ArrowUp className="size-3.5" aria-hidden />
                        ) : sortDir === 'desc' ? (
                          <ArrowDown className="size-3.5" aria-hidden />
                        ) : (
                          <ChevronsUpDown className="size-3.5 opacity-50" aria-hidden />
                        )}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => {
            const activate = onRowClick ? () => onRowClick(row.original) : undefined;
            return (
              <tr
                key={row.id}
                onClick={activate}
                // A11y por teclado: una fila con drill-down imperativo (router.push) no es activable de
                // forma nativa. La hacemos focusable (tabIndex hereda el ring focus-visible del tema) y
                // activable con Enter/Space; `role="link"` declara que navega (espeja el destino-ruta del
                // caller). Solo cuando hay onRowClick: sin él la fila conserva su semántica de fila nativa.
                {...(activate
                  ? {
                      role: 'link',
                      tabIndex: 0,
                      'aria-label': rowLabel?.(row.original),
                      onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          activate();
                        }
                      },
                    }
                  : {})}
                className={cn(
                  'border-b border-border/40 transition-colors',
                  onRowClick && 'cursor-pointer hover:bg-surface-2/60',
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3.5 text-ink">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
