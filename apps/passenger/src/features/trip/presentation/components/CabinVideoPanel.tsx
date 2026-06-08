import { ApiError } from '@veo/api-client';
import { Card, StatusPill, Text, useTheme } from '@veo/ui-kit';
import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import {
  getCabinVideoViewer,
  type CabinViewerState,
} from '../ports/cabinVideoViewer';

/**
 * Panel de la cámara del habitáculo. Integra `GET /trips/:id/video`:
 *  - 200 + visor nativo registrado → renderiza el visor real (oleada nativa).
 *  - 200 sin visor nativo → muestra el contenedor con indicador REC y aviso "visor en la app".
 *  - 403/404 (sin LiveKit o viaje no IN_PROGRESS) → degrada a "sin video", sin inventar credenciales.
 *
 * Solo consulta cuando el viaje está IN_PROGRESS (regla del repo: el indicador REC debe ser visible).
 */
export function CabinVideoPanel({
  tripId,
  active,
  onOpenFullscreen,
}: {
  tripId: string;
  active: boolean;
  /** Abre la cámara a pantalla completa (CameraLive). Solo se ofrece cuando hay grant real. */
  onOpenFullscreen?: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const getVideo = useDependency(TOKENS.getCabinVideoUseCase);
  // Estado REAL de la conexión en vivo del visor (distinto del REC, que refleja la grabación server-side).
  const [viewerState, setViewerState] = useState<CabinViewerState>('connecting');

  const query = useQuery({
    queryKey: ['trip', tripId, 'video'],
    queryFn: () => getVideo.execute(tripId),
    enabled: active,
    // 403/404 no son retryables: el bff degrada explícitamente.
    retry: (count, error) => !(error instanceof ApiError) && count < 1,
    staleTime: 60_000,
  });

  const Viewer = getCabinVideoViewer();
  const hasGrant = query.isSuccess && Boolean(query.data);
  // REC = la grabación server-side está activa (obligatorio mostrarla durante el viaje). Si el bff
  // niega el grant (403/404 → "sin LiveKit o no IN_PROGRESS"), NO hay grabación → no mostramos un REC falso.
  const isRecording = active && !query.isError;
  // Sobrecapa honesta sobre el video: cuando la vista en vivo no está conectada, decimos por qué
  // en vez de dejar un panel en blanco que aparenta un feed en vivo bajo el REC.
  const liveOverlay =
    Viewer && hasGrant && viewerState !== 'live'
      ? viewerState === 'error'
        ? t('trip.cabinVideoUnavailable')
        : t('trip.reconnecting')
      : null;

  return (
    <Card variant="filled" padding="lg">
      <View style={[styles.header, { marginBottom: theme.spacing.sm }]}>
        <Text variant="subhead" color="inkMuted">
          {t('trip.cabinVideoTitle')}
        </Text>
        {isRecording ? (
          <StatusPill label={t('trip.recording')} tone="danger" dot live />
        ) : null}
      </View>

      {/* El escenario es presionable (→ CameraLive) solo cuando HAY grant real y el llamador lo
          habilita: no se ofrece "ver en grande" si no hay nada que ver (degradación honesta). */}
      <Pressable
        accessibilityRole={hasGrant && onOpenFullscreen ? 'button' : undefined}
        accessibilityLabel={hasGrant && onOpenFullscreen ? t('cameraLive.openFullscreen') : undefined}
        disabled={!(hasGrant && onOpenFullscreen)}
        onPress={onOpenFullscreen}
        style={[
          styles.stage,
          { backgroundColor: theme.colors.surfaceElevated, borderRadius: theme.radii.md },
        ]}
      >
        {hasGrant && Viewer ? (
          <>
            <Viewer grant={query.data} onStateChange={setViewerState} />
            {liveOverlay ? (
              <View style={styles.center} pointerEvents="none">
                <Text variant="footnote" color="inkSubtle" align="center">
                  {liveOverlay}
                </Text>
              </View>
            ) : null}
          </>
        ) : (
          <View style={styles.center}>
            <Text variant="footnote" color="inkSubtle" align="center">
              {hasGrant ? t('trip.cabinVideoNative') : t('trip.cabinVideoUnavailable')}
            </Text>
          </View>
        )}
      </Pressable>

      {hasGrant && onOpenFullscreen ? (
        <View style={[styles.hint, { marginTop: theme.spacing.sm }]}>
          <Text variant="footnote" color="inkMuted">
            {t('cameraLive.openFullscreen')}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stage: { height: 180, overflow: 'hidden' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 16 },
  hint: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
});
