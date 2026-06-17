import {ApiError} from '@veo/api-client';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useQuery} from '@tanstack/react-query';
import {Button, IconButton, StatusPill, Text, useTheme} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
  ActivityIndicator,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import type {RootStackParamList} from '../../../../navigation/types';
import {
  getCabinVideoViewer,
  type CabinViewerState,
} from '../ports/cabinVideoViewer';
import {IconArrowLeft, IconCamera, IconUsers} from '../components/icons';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Params = RouteProp<RootStackParamList, 'CameraLive'>;

/** Fondo del escenario de video (marca/diseño, NO un token de tema): negro azulado del handoff. */
const VIDEO_BG = '#0b0d11';

/**
 * Cámara del viaje a PANTALLA COMPLETA (Ola 2A · seguridad). Reusa el MISMO grant que `CabinVideoPanel`
 * (`GET /trips/:id/video` vía `GetCabinVideoUseCase`) y el visor LiveKit registrado por la oleada
 * nativa, pero a `inset:0`. Fiel al diseño `CameraLive`: pill "REC · EN VIVO", card de estado
 * ("Analizando", "Viendo ahora") y botón → CameraControl.
 *
 * Cuatro estados HONESTOS (nunca un negro pelado bajo el REC):
 *  - `connecting`  → spinner + "Conectando con la cámara…".
 *  - `live`        → video + overlays del diseño.
 *  - `error`       → grant OK pero el visor no conectó (o sin visor nativo): aviso explícito.
 *  - `noPermission`→ el bff negó el grant (403/404: sin LiveKit o viaje no IN_PROGRESS).
 */
export function CameraLiveScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const {params} = useRoute<Params>();
  const {tripId} = params;

  const getVideo = useDependency(TOKENS.getCabinVideoUseCase);
  const [viewerState, setViewerState] =
    useState<CabinViewerState>('connecting');

  const query = useQuery({
    queryKey: ['trip', tripId, 'video'],
    queryFn: () => getVideo.execute(tripId),
    // 403/404 (sin LiveKit o no IN_PROGRESS) no son retryables: el bff degrada explícitamente.
    retry: (count, error) => !(error instanceof ApiError) && count < 1,
    staleTime: 60_000,
  });

  const Viewer = getCabinVideoViewer();
  const hasGrant = query.isSuccess && Boolean(query.data);

  // Estado efectivo de la pantalla, derivado del grant + el estado del visor.
  const screenState: 'connecting' | 'live' | 'error' | 'noPermission' =
    query.isError
      ? 'noPermission'
      : !hasGrant || query.isLoading
        ? 'connecting'
        : !Viewer
          ? 'error' // grant OK pero no hay visor nativo registrado en este build.
          : viewerState === 'error'
            ? 'error'
            : viewerState === 'live'
              ? 'live'
              : 'connecting';

  const isLive = screenState === 'live';

  return (
    <View style={[styles.root, {backgroundColor: VIDEO_BG}]}>
      {/* Escenario del video: el visor real llena inset:0 con el mismo grant del panel. */}
      {hasGrant && Viewer ? (
        <View style={StyleSheet.absoluteFill}>
          <Viewer grant={query.data} onStateChange={setViewerState} />
        </View>
      ) : null}

      {/* Estados sin feed: nunca dejamos un negro mudo bajo el REC. */}
      {!isLive ? (
        <View style={styles.center} pointerEvents="none">
          {screenState === 'connecting' ? (
            <>
              <ActivityIndicator color={theme.colors.accent} />
              <Text
                variant="callout"
                color="inkMuted"
                align="center"
                style={styles.stateText}>
                {t('cameraLive.connecting')}
              </Text>
            </>
          ) : (
            <>
              <IconCamera color={theme.colors.inkSubtle} size={34} />
              <Text
                variant="callout"
                color="inkMuted"
                align="center"
                style={styles.stateText}>
                {screenState === 'noPermission'
                  ? t('cameraLive.noPermission')
                  : t('cameraLive.error')}
              </Text>
            </>
          )}
        </View>
      ) : null}

      {/* Gradientes (scrims) top+bottom del diseño para legibilidad de los overlays. SVG (sin dep
          nativa extra: react-native-svg ya está en el proyecto). Tinte de marca #0b0d11 del handoff. */}
      <Scrim
        direction="top"
        style={[styles.gradientTop, {height: 180 + insets.top}]}
      />
      <Scrim direction="bottom" style={styles.gradientBottom} />

      {/* Barra superior: back + pill REC · EN VIVO. */}
      <View style={[styles.topBar, {top: insets.top + theme.spacing.sm}]}>
        <IconButton
          accessibilityLabel={t('actions.back')}
          variant="surface"
          onPress={() => navigation.goBack()}
          icon={<IconArrowLeft color={theme.colors.ink} size={22} />}
        />
        {/* REC = grabación server-side activa: solo si el bff entregó grant (no inventamos un REC falso). */}
        {hasGrant ? (
          <StatusPill label={t('cameraLive.recLive')} tone="danger" dot live />
        ) : null}
      </View>

      {/* Bloque inferior: card de estado + "Viendo ahora" + botón a CameraControl. */}
      <View
        style={[
          styles.bottom,
          {paddingBottom: insets.bottom + theme.spacing.xl},
        ]}>
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderRadius: theme.radii.lg,
              borderColor: theme.colors.border,
            },
          ]}>
          <View style={styles.cardHeader}>
            <IconCamera color={theme.colors.accent} size={22} />
            <View style={styles.flex}>
              <Text variant="bodyStrong">{t('cameraLive.cardTitle')}</Text>
              <Text variant="footnote" color="inkMuted">
                {t('cameraLive.cardSubtitle')}
              </Text>
            </View>
            {isLive ? (
              <StatusPill
                label={t('cameraLive.analyzing')}
                tone="success"
                dot
              />
            ) : null}
          </View>

          {isLive ? (
            <View
              style={[
                styles.viewingRow,
                {borderTopColor: theme.colors.border},
              ]}>
              <Text variant="footnote" color="inkMuted">
                {t('cameraLive.viewingNow')}
              </Text>
            </View>
          ) : null}
        </View>

        <Button
          label={t('cameraLive.controlButton')}
          variant="secondary"
          fullWidth
          leftIcon={<IconUsers color={theme.colors.ink} size={18} />}
          onPress={() => navigation.navigate('CameraControl', {tripId})}
        />
      </View>
    </View>
  );
}

/**
 * Scrim (degradado de opacidad) sobre el video para legibilidad de los overlays. Usa react-native-svg
 * (ya presente) con el tinte de marca del fondo del video (#0b0d11), no un token de tema.
 */
function Scrim({
  direction,
  style,
}: {
  direction: 'top' | 'bottom';
  style: ViewStyle | ViewStyle[];
}): React.JSX.Element {
  // top: opaco arriba → transparente; bottom: transparente → opaco abajo.
  const topOpacity = direction === 'top' ? 0.7 : 0;
  const bottomOpacity = direction === 'top' ? 0 : 0.96;
  return (
    <View style={style} pointerEvents="none">
      <Svg width="100%" height="100%">
        <Defs>
          <SvgLinearGradient
            id={`scrim-${direction}`}
            x1="0"
            y1="0"
            x2="0"
            y2="1">
            <Stop offset="0" stopColor={VIDEO_BG} stopOpacity={topOpacity} />
            <Stop offset="1" stopColor={VIDEO_BG} stopOpacity={bottomOpacity} />
          </SvgLinearGradient>
        </Defs>
        <Rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill={`url(#scrim-${direction})`}
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  center: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 32,
  },
  stateText: {maxWidth: 280},
  gradientTop: {position: 'absolute', top: 0, left: 0, right: 0},
  gradientBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 260,
  },
  topBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 22,
    gap: 12,
  },
  card: {padding: 16, borderWidth: 1},
  cardHeader: {flexDirection: 'row', alignItems: 'center', gap: 12},
  flex: {flex: 1},
  viewingRow: {marginTop: 12, paddingTop: 12, borderTopWidth: 1},
});
