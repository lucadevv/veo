import {useMutation} from '@tanstack/react-query';
import {useRepositories} from '../../../../core/di/useDi';
import {SubmitRegistrationUseCase} from '../../domain';
import {useRegistrationStore} from '../state/registrationStore';

/**
 * Mutación de cierre del alta: compone el borrador del store, lo valida vía el caso de uso y delega
 * en el repositorio obtenido por DI (abstracción `RegistrationRepository`, que por inyección resuelve
 * a `HttpRegistrationRepository` contra el driver-bff). Al éxito, persiste en el store el estado que
 * el backend reporta para el conductor (derivado de `GET /drivers/me` en el repositorio), lo que hace
 * que el `RootNavigator` conmute por estado (p. ej. a "Estamos revisando tus datos" si queda
 * `in_review`). La aprobación NUNCA se decide localmente: la reconcilia el gate (`useRegistrationGate`).
 *
 * Nota: los datos de cada paso (personal, vehículo, documentos, licencia y biometría) ya se enviaron
 * a sus endpoints reales con sus propios hooks; este `submit` solo siembra el estado inicial del alta.
 */
export function useRegistrationSubmit() {
  const {registration} = useRepositories();
  const buildDraft = useRegistrationStore(s => s.buildDraft);
  const setStatus = useRegistrationStore(s => s.setStatus);

  return useMutation({
    mutationFn: () => new SubmitRegistrationUseCase(registration).execute(buildDraft()),
    onSuccess: result => setStatus(result.status),
  });
}
