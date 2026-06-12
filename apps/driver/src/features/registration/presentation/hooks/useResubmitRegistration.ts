import {useMutation, useQueryClient} from '@tanstack/react-query';
import {useRepositories} from '../../../../core/di/useDi';
import {useRegistrationStore} from '../state/registrationStore';
import {REGISTRATION_GATE_QUERY_KEY} from './useRegistrationGate';

/**
 * Reenvío a revisión tras un rechazo (resubmit). El conductor RECHAZADO corrigió sus datos y vuelve a
 * la cola de aprobación (`POST /drivers/me/resubmit` → REJECTED → PENDING en identity). Al éxito:
 *  1. siembra `in_review` en el store (el conductor ya no está rechazado: pasa a revisión), y
 *  2. invalida la query del gate para que `useRegistrationGate` re-resuelva contra el backend y el
 *     `RootNavigator` conmute por estado (sacándolo de la pantalla de rechazo).
 *
 * La transición la valida el backend (un conductor no rechazado obtiene error); acá solo se refleja el
 * resultado. La aprobación final NUNCA se decide localmente.
 */
export function useResubmitRegistration() {
  const {registration} = useRepositories();
  const setStatus = useRegistrationStore(s => s.setStatus);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => registration.resubmit(),
    onSuccess: () => {
      setStatus('in_review');
      void queryClient.invalidateQueries({queryKey: REGISTRATION_GATE_QUERY_KEY});
    },
  });
}
