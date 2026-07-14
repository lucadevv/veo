import {useFocusEffect} from '@react-navigation/native';
import {useCallback} from 'react';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {useSessionStore} from '../../../../core/session/sessionStore';
import {useActiveTripStore} from '../stores/activeTripStore';

/**
 * Rehidrata el viaje ACTIVO del pasajero desde el server al ENFOCAR la pantalla — montaje inicial y al
 * volver al tab Home (que se desmonta por `detachInactiveScreens`). Adopta el id en el `activeTripStore`
 * para que el sheet unificado vuelva al estado real del viaje (re-entrada).
 *
 * Reglas (a propósito):
 *  - Solo corre AUTENTICADO (sin token no hay a quién consultar).
 *  - Si NO hay viaje vivo (`/trips/active` → null), busca un CIERRE pendiente (`/trips/pending-settlement`):
 *    un viaje COMPLETED que aún no se cerró. COMPLETED es terminal, así que tras un reload `/trips/active`
 *    ya no lo devuelve — pero el cobro/recibo + rating siguen pendientes (es plata). Adoptarlo re-ofrece
 *    el cierre (la fase `completed` ya renderiza el recibo). El cierre lo termina la pantalla vía
 *    `closeTrip` + `clear`, lo que saca el viaje de pending-settlement.
 *  - Solo ADOPTA cuando el server reporta un viaje (vivo o por cerrar); NUNCA limpia en `null`. El cierre
 *    lo maneja la pantalla vía sus transiciones terminales — así evitamos una carrera donde una
 *    rehidratación con lag borre un viaje recién creado localmente.
 *  - Best-effort: si la consulta falla, la pantalla sigue operativa para pedir un viaje nuevo.
 */
export function useHydrateActiveTrip(): void {
  const getMyActiveTrip = useDependency(TOKENS.getMyActiveTripUseCase);
  const getPendingSettlement = useDependency(
    TOKENS.getPendingSettlementUseCase,
  );
  const history = useDependency(TOKENS.tripHistoryRepository);
  const setActiveTripId = useActiveTripStore(s => s.setActiveTripId);
  const setActiveTripMode = useActiveTripStore(s => s.setActiveTripMode);
  const setActiveTripVehicleType = useActiveTripStore(
    s => s.setActiveTripVehicleType,
  );

  useFocusEffect(
    useCallback(() => {
      const {accessToken} = useSessionStore.getState();
      if (!accessToken) {
        return;
      }
      let cancelled = false;
      void getMyActiveTrip
        .execute()
        // Sin viaje vivo: probamos el cierre pendiente (COMPLETED sin cerrar → re-entrada al recibo).
        .then(trip => (trip ? trip : getPendingSettlement.execute()))
        .then(trip => {
          if (!cancelled && trip) {
            setActiveTripId(trip.id);
            // Modo CONGELADO por el server (mismo mapeo que `onTripCreated`): con él, relanzar la app a
            // mitad de una búsqueda FIXED preserva la fase correcta (EXPIRED → 'noDriver', no la re-puja).
            // OPTIONAL/nullable en el contrato (compat N-2): sin el campo, el modo queda null y la fase
            // degrada al comportamiento PUJA histórico (no peor que antes).
            if (trip.dispatchMode) {
              setActiveTripMode(trip.dispatchMode);
            }
            // Tipo de vehículo del viaje: la fuente de verdad es el SERVER (`tripActiveView.vehicleType`,
            // el trip conoce su oferta) — cubre relaunch, adopción por 409 y cross-device. El snapshot
            // MMKV local (grabado al crear con el `tripResource`) queda como FALLBACK para un BFF viejo
            // que aún no emite el campo (compat N-2). Sin ninguno de los dos, queda null y el mapa
            // degrada al glyph de auto (comportamiento histórico, nunca peor).
            const snapshotType = history
              .list()
              .find(t => t.id === trip.id)?.vehicleType;
            const vehicleType = trip.vehicleType ?? snapshotType;
            if (vehicleType) {
              setActiveTripVehicleType(vehicleType);
            }
          }
        })
        .catch(() => {
          // Rehidratación best-effort: si falla, no rompemos el home.
        });
      return () => {
        cancelled = true;
      };
    }, [
      getMyActiveTrip,
      getPendingSettlement,
      history,
      setActiveTripId,
      setActiveTripMode,
      setActiveTripVehicleType,
    ]),
  );
}
