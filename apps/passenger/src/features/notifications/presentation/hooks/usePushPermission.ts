import {useFocusEffect} from '@react-navigation/native';
import {useCallback, useState} from 'react';
import {
  enablePush,
  getPushPermission,
  type PushPermission,
} from '../../../../services/messaging';

export type PushPermissionUi = PushPermission | 'loading';

export interface UsePushPermission {
  /** Estado del permiso del SO: 'granted' | 'denied' | 'undetermined' (o 'loading' mientras resuelve). */
  status: PushPermissionUi;
  /** Pide el permiso (diálogo del SO la 1ra vez) y registra el token si queda concedido. Devuelve el estado. */
  enable: () => Promise<PushPermission>;
  /** Re-lee el estado sin promptear (p. ej. al volver de Ajustes del SO). */
  refresh: () => void;
}

/**
 * Estado del permiso de push + activación, para el toggle del Perfil y el pre-prompt contextual.
 *
 * Lee el estado REAL del SO (`getPushPermission`, sin diálogo) y lo re-lee al ENFOCAR la pantalla: si el
 * usuario fue a Ajustes del sistema a activarlo/desactivarlo y volvió, el toggle refleja el cambio. La
 * activación (`enable`) dispara el diálogo del SO la primera vez y registra el token (`POST /devices`).
 */
export function usePushPermission(): UsePushPermission {
  const [status, setStatus] = useState<PushPermissionUi>('loading');

  const refresh = useCallback(() => {
    void getPushPermission().then(setStatus);
  }, []);

  // Re-leer al enfocar (volver de Ajustes del SO). useFocusEffect corre el efecto en cada focus.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const enable = useCallback(async () => {
    const next = await enablePush();
    setStatus(next);
    return next;
  }, []);

  return {status, enable, refresh};
}
