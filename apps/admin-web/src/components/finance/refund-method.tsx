import { Wallet, CreditCard, Banknote, Receipt, type LucideIcon } from 'lucide-react';
import type { MobilePaymentMethod } from '@/lib/api/schemas';

/**
 * Método de pago del cobro reembolsado → etiqueta es-PE + ícono, FIEL al frame HZ8uz (Yape/Plin = wallet,
 * Tarjeta = credit-card). Mapa por clave TIPADA del enum del contrato (`MobilePaymentMethod`), no comparación de
 * strings sueltos: agregar un método al enum obliga a mapearlo acá (error de compilación si falta). Íconos de
 * lucide (nunca emoji).
 */
const METHOD: Record<MobilePaymentMethod, { label: string; icon: LucideIcon }> = {
  YAPE: { label: 'Yape', icon: Wallet },
  PLIN: { label: 'Plin', icon: Wallet },
  CARD: { label: 'Tarjeta', icon: CreditCard },
  CASH: { label: 'Efectivo', icon: Banknote },
  PAGOEFECTIVO: { label: 'PagoEfectivo', icon: Receipt },
};

/** Celda "Método": ícono gris + etiqueta (columna cMet del T/RowReembolso). */
export function RefundMethodCell({ method }: { method: MobilePaymentMethod }) {
  const { label, icon: Icon } = METHOD[method];
  return (
    <span className="inline-flex items-center gap-2 text-ink">
      <Icon className="size-[15px] shrink-0 text-ink-subtle" aria-hidden />
      {label}
    </span>
  );
}

export function refundMethodLabel(method: MobilePaymentMethod): string {
  return METHOD[method].label;
}
