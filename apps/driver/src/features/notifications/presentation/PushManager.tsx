import {useEffect} from 'react';
import {useDi} from '../../../core/di/useDi';
import {HttpPushRegistrationPort} from '../data/http-push-registration';
import {fcmPushService} from '../data/fcm-push-service';

/**
 * Inicializa el push del conductor mientras la sesión está activa: pide permisos, obtiene el token,
 * lo registra en el driver-bff (`POST /notifications/device-token`) y engancha los handlers
 * (foreground/quita). No renderiza UI. La baja del token (`DELETE`) ocurre en el logout.
 *
 * Si el registro falla (o Firebase no está configurado en sandbox) se degrada en modo log sin romper
 * la app. Ningún handler muestra alertas (regla #2: UI engañosa).
 */
export const PushManager = (): null => {
  const {httpClient} = useDi();

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let active = true;
    fcmPushService
      .start(new HttpPushRegistrationPort(httpClient))
      .then(unsubscribe => {
        if (active) {
          cleanup = unsubscribe;
        } else {
          unsubscribe();
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      cleanup?.();
    };
  }, [httpClient]);

  return null;
};
