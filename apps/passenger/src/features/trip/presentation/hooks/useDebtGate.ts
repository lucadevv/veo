import type { DebtView } from '@veo/api-client';
import { useCallback, useState } from 'react';
import { useMyDebts } from '../../../payments/presentation';

export interface DebtGateController {
  /** El `DebtSheet` está visible (cualquiera de los dos orígenes: pedido bloqueado 403 / franja del home). */
  debtSheetOpen: boolean;
  /** Vista de deuda para el sheet: la real del endpoint (`null` hasta que la query resuelva). */
  debtView: DebtView | null;
  /** Hay una DEUDA real (cobro en DEBT, bloquea pedir) → franja warn del home. */
  hasDebt: boolean;
  /** Total de la deuda en céntimos (para la franja). */
  debtTotalCents: number;
  /** Hay un PAGO POR COMPLETAR (PENDING con checkout vivo, NO bloquea) y NO hay deuda (la deuda prioriza). */
  hasPendingAction: boolean;
  /**
   * Cuando el sheet se abre para un PAGO POR COMPLETAR, este id le dice que cargue el cobro fresco y abra
   * su checkout directo (en vez del flujo de deuda). `null` = sheet en modo deuda.
   */
  pendingActionPaymentId: string | null;
  /**
   * Señal para RE-INTENTAR el pedido solo: se incrementa al saldar una deuda que vino de un pedido
   * bloqueado; `QuotingBody` la observa y re-dispara el create.
   */
  requestAgainToken: number;
  /** El 403 DEBT_PENDING bloqueó un pedido → abre el sheet de deuda (origen: pedido) en vez de un error. */
  onDebtPending: () => void;
  /** Franja del home (DEUDA) → abre el MISMO sheet (origen: home, sin pedido que reintentar). */
  openDebtFromHome: () => void;
  /** Franja del home (PAGO POR COMPLETAR) → abre el sheet en modo PENDING_ACTION: checkout directo. */
  openPendingFromHome: () => void;
  closeDebtSheet: () => void;
  /** Deuda SALDADA: cierra el sheet y, si vino de un pedido bloqueado, re-intenta el pedido solo. */
  onDebtSettled: () => void;
}

/**
 * DEUDA (BR-P02) · la máquina del gate de deuda del home, encapsulada (SRP). Posee el estado del
 * `DebtSheet` y su ORIGEN: `debtFromBlockedRequest` distingue si lo abrió un pedido bloqueado (403)
 * —entonces, tras saldar, RE-INTENTAMOS el pedido— de la franja del home (solo cerrar).
 *
 * @param enabled señal PASIVA: consulta las deudas SOLO en el home idle (no en viaje/cotización) para no
 *   golpear el endpoint en cada pantalla. Alimenta la franja sutil del home y siembra el DebtSheet.
 */
export function useDebtGate(enabled: boolean): DebtGateController {
  const [debtSheetOpen, setDebtSheetOpen] = useState(false);
  const [debtFromBlockedRequest, setDebtFromBlockedRequest] = useState(false);
  const [requestAgainToken, setRequestAgainToken] = useState(0);
  const [pendingActionPaymentId, setPendingActionPaymentId] = useState<string | null>(null);

  const debtsQuery = useMyDebts(enabled);
  const hasDebt = debtsQuery.data?.hasDebt ?? false;
  // Si el 403 abrió el sheet antes de que la query resuelva, igual cae el fetch (enabled en idle) y la
  // completa; el sheet salda la más antigua.
  const debtView: DebtView | null = debtsQuery.data ?? null;

  // PAGO POR COMPLETAR (PENDING_ACTION): el primer cobro PENDING con checkout vivo (no es deuda). Solo lo
  // ofrecemos en la franja si NO hay deuda (la deuda es lo accionable urgente y tiene prioridad). Es el
  // dead-end que resolvemos: un pago a medias al que ahora se puede VOLVER desde el home.
  const firstPendingAction = debtView?.debts.find((d) => d.kind === 'PENDING_ACTION') ?? null;
  const hasPendingAction = !hasDebt && firstPendingAction != null;

  const onDebtPending = useCallback(() => {
    setPendingActionPaymentId(null);
    setDebtFromBlockedRequest(true);
    setDebtSheetOpen(true);
    // Asegura datos frescos de la deuda para el sheet (el gate es server-side; refrescamos el detalle).
    void debtsQuery.refetch();
  }, [debtsQuery]);

  const openDebtFromHome = useCallback(() => {
    setPendingActionPaymentId(null);
    setDebtFromBlockedRequest(false);
    setDebtSheetOpen(true);
  }, []);

  const openPendingFromHome = useCallback(() => {
    if (!firstPendingAction) {
      return;
    }
    setPendingActionPaymentId(firstPendingAction.paymentId);
    setDebtFromBlockedRequest(false);
    setDebtSheetOpen(true);
  }, [firstPendingAction]);

  const closeDebtSheet = useCallback(() => setDebtSheetOpen(false), []);

  // Deuda SALDADA: cierra el sheet. Si vino de un pedido bloqueado, RE-INTENTA el pedido solo (incrementa
  // el token que QuotingBody observa); si vino del home, solo cierra (la franja desaparece sola al
  // invalidarse la caché de deudas dentro del DebtSheet).
  const onDebtSettled = useCallback(() => {
    setDebtSheetOpen(false);
    setPendingActionPaymentId(null);
    if (debtFromBlockedRequest) {
      setRequestAgainToken((n) => n + 1);
      setDebtFromBlockedRequest(false);
    }
  }, [debtFromBlockedRequest]);

  return {
    debtSheetOpen,
    debtView,
    hasDebt,
    debtTotalCents: debtsQuery.data?.totalCents ?? 0,
    hasPendingAction,
    pendingActionPaymentId,
    requestAgainToken,
    onDebtPending,
    openDebtFromHome,
    openPendingFromHome,
    closeDebtSheet,
    onDebtSettled,
  };
}
