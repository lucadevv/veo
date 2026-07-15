import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRepositories } from '../../../../core/di/useDi';
import {
  GetProfileUseCase,
  profileToSessionUser,
  type DriverProfile,
} from '../../../profile/domain';
import {
  mapProfileToRegistrationStatus,
  resumeStepForProfile,
  type RegistrationStatus,
} from '../../domain';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { useRegistrationStore } from '../state/registrationStore';
import { REGISTRATION_GATE_QUERY_KEY } from './useRegistrationGate';

/**
 * Cierre del alta (post-enroll del KYC): NO re-gatea con el borrador LOCAL (en un alta REANUDADA ese
 * borrador está vacío en personal/vehículo —esos datos viven en el backend, no en el store fresco— y
 * un gate local daría `false` falsamente, escondiendo el éxito real bajo un error genérico). El backend
 * es la ÚNICA fuente de verdad: cada paso (personal/vehículo/documentos/biometría) ya se persistió en su
 * endpoint, así que el "cierre" es solo un PROBE de estado.
 *
 * REUSA el refresh del gate (`useRegistrationGate`): hace el MISMO `GET /drivers/me` y aplica el MISMO
 * mapeo/efectos (`applyBackendStatus` + `resumeStepForProfile` → `setCurrentStep` + `profileToSessionUser`
 * → `setUser`), sin duplicar la lógica. Resultado:
 *  - server completo (docs + biometría) ⇒ `in_review` ⇒ el `RootNavigator` conmuta a "estamos revisando".
 *  - server incompleto ⇒ `in_progress` ⇒ rutea al paso que falta (server-driven `resumeStepForProfile`),
 *    NO un error genérico.
 *
 * Además ceba la caché del gate (`REGISTRATION_GATE_QUERY_KEY`) con el perfil recién leído, para que el
 * gate montado en el `RootNavigator` no dispare un segundo `GET /me` al conmutar de pantalla.
 */
export function useRegistrationSubmit() {
  const { profile } = useRepositories();
  const queryClient = useQueryClient();
  const applyBackendStatus = useRegistrationStore((s) => s.applyBackendStatus);
  const setCurrentStep = useRegistrationStore((s) => s.setCurrentStep);
  const setUser = useSessionStore((s) => s.setUser);

  return useMutation<RegistrationStatus, Error, void>({
    mutationFn: async () => {
      const driverProfile: DriverProfile = await new GetProfileUseCase(profile).execute();
      // Siembra la caché del gate con el perfil ya leído: evita un GET /me redundante al re-renderizar.
      queryClient.setQueryData(REGISTRATION_GATE_QUERY_KEY, driverProfile);

      const status = mapProfileToRegistrationStatus(driverProfile);
      // Sincroniza el store con la MISMA secuencia que el gate (no setState suelto, no lógica duplicada).
      applyBackendStatus(status);
      const resumeStep = resumeStepForProfile(driverProfile.compliance);
      if (resumeStep !== null) {
        setCurrentStep(resumeStep);
      }
      setUser(profileToSessionUser(driverProfile));
      return status;
    },
  });
}
