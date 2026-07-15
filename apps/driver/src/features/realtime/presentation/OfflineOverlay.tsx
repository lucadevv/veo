import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Button, useTheme } from '@veo/ui-kit';
import { NoticeHero } from '../../../shared/presentation/components/NoticeHero';
import { IconWifiOff } from '../../../shared/presentation/icons';
import NetInfo from '@react-native-community/netinfo';
import { useDispatchStore } from './state/dispatchStore';

/**
 * ¿Estamos SIN conexión? Combina DOS señales:
 *  1. Conectividad REAL del dispositivo (SO) vía `@react-native-community/netinfo`: airplane mode, sin
 *     wifi ni datos, o internet inalcanzable → offline inmediato (el enlace físico cayó).
 *  2. Salud del socket `/driver`: VEO backend inalcanzable AUNQUE el dispositivo tenga internet.
 *     Con debounce de 2.5s (un blip transitorio no dispara el overlay full-screen — para eso está el
 *     pill "Reconectando…") y solo tras el primer handshake (`connected` arranca `false`, evita el
 *     parpadeo de arranque).
 */
function useIsOffline(): boolean {
  const connected = useDispatchStore((s) => s.connected);
  const [socketDown, setSocketDown] = useState(false);
  const [deviceOffline, setDeviceOffline] = useState(false);
  const hasConnected = useRef(false);

  // (1) Conectividad del SO. `isInternetReachable` puede ser null mientras se resuelve → no lo tratamos
  //     como offline (solo `false` explícito o `isConnected=false`).
  useEffect(() => {
    const unsub = NetInfo.addEventListener((state) => {
      setDeviceOffline(!state.isConnected || state.isInternetReachable === false);
    });
    return () => unsub();
  }, []);

  // (2) Socket con VEO, debounced.
  useEffect(() => {
    if (connected) {
      hasConnected.current = true;
      setSocketDown(false);
      return;
    }
    if (!hasConnected.current) {
      return;
    }
    const timer = setTimeout(() => setSocketDown(true), 2500);
    return () => clearTimeout(timer);
  }, [connected]);

  return deviceOffline || socketDown;
}

/**
 * Overlay global "Sin conexión" (frame `C/SinConexion`): tapa la app cuando se pierde la conexión con
 * VEO. "Reintentar" fuerza un refetch de las queries observadas (estado de turno / viaje / pujas); el
 * socket reconecta solo y, al volver `connected`, el overlay se cierra. Se monta una sola vez a nivel
 * raíz (junto a `RealtimeManager`), por encima de todo el árbol de navegación.
 */
export function OfflineOverlay(): React.JSX.Element | null {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const offline = useIsOffline();
  const requestReconnect = useDispatchStore((s) => s.requestReconnect);
  // Feedback del tap: el botón queda en "reconectando…" un momento (si la conexión vuelve, el overlay se
  // cierra solo al llegar `connected`; si no, el botón se re-habilita para reintentar). Antes el tap no
  // daba NINGUNA señal → se sentía muerto.
  const [retrying, setRetrying] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);

  const onRetry = (): void => {
    setRetrying(true);
    // (1) Reevaluar la conectividad REAL del SO: `isInternetReachable` de NetInfo puede quedar STALE en
    //     `false` aunque la red haya vuelto → sin este refresh el overlay no cerraba nunca.
    NetInfo.refresh().catch(() => undefined);
    // (2) Forzar la reconexión del socket `/driver` YA (socket fresco + token re-leído), sin esperar el
    //     backoff de socket.io. Al volver `connected`, `useIsOffline` cae a false y el overlay se cierra.
    requestReconnect();
    // (3) Refrescar el estado autoritativo por REST (turno/viaje/pujas) una vez que haya red.
    queryClient.invalidateQueries();
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => setRetrying(false), 2500);
  };

  if (!offline) {
    return null;
  }

  return (
    <View
      style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: theme.colors.bg }]}
      accessibilityViewIsModal
      accessibilityLiveRegion="polite"
    >
      <NoticeHero
        tone="danger"
        icon={({ size, color }) => <IconWifiOff size={size} color={color} strokeWidth={2} />}
        title={t('offline.title')}
        description={t('offline.body')}
      >
        <View style={styles.action}>
          <Button
            label={t('offline.retry')}
            variant="primary"
            loading={retrying}
            disabled={retrying}
            onPress={onRetry}
          />
        </View>
      </NoticeHero>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { zIndex: 1000, elevation: 1000 },
  // Botón "Reintentar" centrado (frame C/SinConexion): el wrapper se auto-centra dentro del slot
  // `extra` (full-width) de NoticeHero, en vez de quedar pegado a la izquierda.
  action: { alignSelf: 'center' },
});
