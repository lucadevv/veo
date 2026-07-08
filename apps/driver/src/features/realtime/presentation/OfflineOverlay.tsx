import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Button, useTheme } from '@veo/ui-kit';
import { NoticeHero } from '../../../shared/presentation/components/NoticeHero';
import { IconWifiOff } from '../../../shared/presentation/icons';
import { useDispatchStore } from './state/dispatchStore';

/**
 * ¿Estamos SIN conexión con VEO? Deriva del estado `connected` del socket `/driver` (única señal de
 * conectividad global que ya existe en la app). Dos defensas contra falsos positivos:
 *  1. Solo se activa si YA estuvimos conectados alguna vez (`connected` arranca `false`: sin esto el
 *     overlay parpadearía en cada arranque, antes del primer handshake).
 *  2. Debounce de 2.5s: un blip transitorio (túnel, zona muerta breve) no dispara el overlay a
 *     pantalla completa — para eso ya está el pill "Reconectando…" del dashboard/viaje.
 *
 * LIMITACIÓN HONESTA: sin `@react-native-community/netinfo` (no está en las deps del driver) NO hay
 * detección de internet real a nivel de SO; esto refleja la salud del socket, no del enlace físico.
 */
function useIsOffline(): boolean {
  const connected = useDispatchStore((s) => s.connected);
  const [offline, setOffline] = useState(false);
  const hasConnected = useRef(false);

  useEffect(() => {
    if (connected) {
      hasConnected.current = true;
      setOffline(false);
      return;
    }
    if (!hasConnected.current) {
      return;
    }
    const timer = setTimeout(() => setOffline(true), 2500);
    return () => clearTimeout(timer);
  }, [connected]);

  return offline;
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
            onPress={() => {
              queryClient.invalidateQueries();
            }}
          />
        </View>
      </NoticeHero>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { zIndex: 1000, elevation: 1000 },
  action: { alignItems: 'center' },
});
