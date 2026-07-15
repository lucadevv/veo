/**
 * Exportación CSV client-side (sin backend): arma el texto, escapa comillas/comas/saltos, y dispara la descarga
 * vía un <a download>. Exporta lo que el operador VE (las filas ya filtradas/ordenadas) — degradación honesta:
 * es la vista actual, no un dump del servidor. Prefija BOM (\uFEFF) para que Excel respete UTF-8 (acentos/ñ).
 */
const BOM = '\uFEFF';

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
): void {
  const esc = (v: string | number | null | undefined): string => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
