import type {TripActiveView} from '@veo/api-client';
import {Text, useTheme} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {SettlementBody} from '../../../payments/presentation/components/SettlementBody';
import {RatingBody} from '../../../ratings/presentation/components/RatingBody';

export interface CompletionBodyProps {
  tripId: string;
  /** Viaje completado (de la vista activa): tarifa a cobrar + conductor a calificar. */
  trip: TripActiveView;
  /** El cierre terminó (liquidado + calificado/salteado) → la pantalla vuelve al home idle. */
  onDone: () => void;
}

type Step = 'settle' | 'rate';

/**
 * Cuerpo del CIERRE del viaje (fase `completed`) del sheet unificado: orquesta los dos pasos del
 * settlement —LIQUIDACIÓN (recibo del cobro automático) → CALIFICACIÓN (salteable)— in-sheet, sin
 * navegar. Mini-máquina de estados LOCAL (`step`): el estado del server queda en COMPLETED durante
 * todo el cierre, así que el paso settle→rating es responsabilidad del cliente, encapsulada acá (SRP).
 * Si el viaje no tuvo conductor (sin rating posible), tras liquidar cierra directo.
 *
 * REGLA DE CIERRE (re-entrada · es plata): al terminar el flujo se llama `closeTrip(tripId)` (idempotente,
 * marca `passengerClosedAt` server-side) y se limpia el `activeTripStore` vía `onDone`, sacando el viaje
 * de `GET /trips/pending-settlement`. EXCEPCIÓN: si el cobro es efectivo PENDING que el pasajero AÚN no
 * confirmó y elige "Confirmar después" (`onDeferred`), NO se cierra: se limpia el store para volver al
 * home, pero al re-enfocar `useHydrateActiveTrip` re-adopta el settlement pendiente y re-ofrece el cierre.
 */
export function CompletionBody({
  tripId,
  trip,
  onDone,
}: CompletionBodyProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const closeTrip = useDependency(TOKENS.closeTripUseCase);
  const driverId = trip.driver?.id ?? null;
  const [step, setStep] = useState<Step>('settle');

  /** Cierre terminal: cierra el post-viaje server-side (best-effort, idempotente) y vuelve al home. */
  const finishAndClose = (): void => {
    // El close es idempotente y best-effort: si falla la red, igual volvemos al home (el server
    // re-ofrecerá el settlement vía pending-settlement en la próxima rehidratación). No bloqueamos al
    // usuario en un viaje ya liquidado por un error transitorio de un flag de UX.
    void closeTrip.execute(tripId).catch(() => undefined);
    onDone();
  };

  /** Escape sin cerrar (efectivo PENDING sin confirmar): vuelve al home pero deja el settlement vivo. */
  const deferClose = (): void => {
    onDone();
  };

  return (
    <View style={{gap: theme.spacing.lg}}>
      <Text variant="title3">{t('trip.completedTitle')}</Text>
      {step === 'settle' ? (
        <SettlementBody
          tripId={tripId}
          onSettled={() => (driverId ? setStep('rate') : finishAndClose())}
          onDeferred={deferClose}
          // Calificar es OPCIONAL: desde el recibo ya resuelto el pasajero puede cerrar directo (mismo
          // camino terminal que el cierre final), sin pasar por el rating. Si el viaje no tuvo conductor,
          // `onSettled` ya cierra directo, así que esta salida no se ofrece (no duplicamos botones).
          onFinish={finishAndClose}
          canFinish={driverId != null}
        />
      ) : driverId ? (
        <RatingBody
          tripId={tripId}
          driverId={driverId}
          onDone={finishAndClose}
        />
      ) : null}
    </View>
  );
}
