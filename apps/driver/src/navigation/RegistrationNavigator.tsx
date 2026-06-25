import React from 'react';
import {
  RealFaceCaptureProvider,
  RegistrationWizardScreen,
} from '../features/registration/presentation';

/**
 * Wizard de registro (LOTE C · "sensación de onboarding"): UNA sola pantalla con un PAGER horizontal de los
 * 3 pasos (Datos · Vehículo · Identidad), en vez de 3 rutas de navegación separadas. El progress lineal, el
 * footer unificado (Atrás | Primary) y las transiciones animadas viven en `RegistrationWizardScreen`; el
 * estado del alta sigue en el store del feature. El "atrás" del header (único control) SALE del onboarding
 * (cerrar sesión); el `Atrás` del footer camina los pasos por índice respetando el gating.
 *
 * La captura de la SELFIE del KYC (cámara frontal nativa, una foto) se inyecta vía `RealFaceCaptureProvider`
 * (puerto propio del registro, independiente de la captura del turno).
 */
export const RegistrationNavigator = (): React.JSX.Element => {
  return (
    <RealFaceCaptureProvider>
      <RegistrationWizardScreen />
    </RealFaceCaptureProvider>
  );
};
