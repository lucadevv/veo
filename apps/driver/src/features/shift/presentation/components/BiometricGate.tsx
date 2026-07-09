import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Banner, Button, IconButton, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { IconCheck, IconChevronLeft, IconShield } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { Pulse } from './motion';
// Cross-feature (pragmático): la cámara frontal en vivo vive hoy en las components del registro. El
// biométrico de turno reusa el MISMO lenguaje que el KYC del alta (cara en vivo en círculo) para no
// divergir. DEUDA: promover BiometricCameraPreview a `shared/` para no acoplar shift→registro.
import {
  BiometricCameraPreview,
  type BiometricCameraErrorPayload,
} from '../../../registration/presentation/components';
import { hexAlpha } from '../../../../shared/presentation/color';

/** Aviso de resultado del flujo biométrico (mismo contrato que `Banner`). */
export interface BiometricGateBanner {
  tone: 'warn' | 'danger' | 'info' | 'success';
  title: string;
  description?: string;
}

export interface BiometricGateProps {
  /** Título de la barra superior. */
  topTitle: string;
  /** Titular grande (qué se va a hacer). Estándar Tesla: alineado a la izquierda, `display`. */
  heading: string;
  /** Texto explicativo del proceso. */
  body: string;
  /** Aviso de resultado (éxito/fallo/bloqueo); `null` para no mostrar nada. */
  banner: BiometricGateBanner | null;
  /** Texto del botón de captura (lo decide el flujo según su fase). */
  ctaLabel: string;
  /** Estado de carga del flujo (captura de liveness en curso): deshabilita y muestra spinner. */
  loading: boolean;
  /** Deshabilita el CTA sin spinner (p. ej. bloqueo biométrico de 1h: no se puede reintentar todavía). */
  disabled?: boolean;
  /** Dispara la captura biométrica (cableado al hook del flujo). El gate ORQUESTA el handoff de cámara. */
  onCapture: () => void;
  /** Retroceso de navegación. */
  onBack: () => void;
}

/** Estado HONESTO de la cámara frontal (mismo criterio que el KYC del registro). */
type CameraState = 'starting' | 'ready' | 'error';

/** Milisegundos que esperamos tras DESMONTAR la preview antes de disparar la captura nativa: el módulo
 *  nativo es el ÚNICO dueño de la cámara durante el liveness, así que la preview debe LIBERARLA primero. */
const CAMERA_HANDOFF_MS = 400;

const RING = 240;

/**
 * Gate biométrico premium compartido (inicio de turno y re-enrolamiento). Habla el MISMO lenguaje que el
 * KYC del alta (`IdentityVerificationScreen`): hero editorial a la izquierda (`display`), cara EN VIVO en
 * círculo mientras encuadrás, banda de estado y CTA fija inferior. Puramente presentacional salvo el
 * HANDOFF de cámara que orquesta: muestra la preview (te ves), y al capturar la desmonta y libera el sensor
 * ANTES de llamar al grabber nativo de liveness (que abre/cierra la cámara él mismo). Degradación honesta:
 * si la cámara falla, cae al flujo sin preview (el liveness sigue funcionando).
 */
export const BiometricGate = ({
  topTitle,
  heading,
  body,
  banner,
  ctaLabel,
  loading,
  disabled = false,
  onCapture,
  onBack,
}: BiometricGateProps): React.JSX.Element => {
  const theme = useTheme();

  const [cameraState, setCameraState] = useState<CameraState>('starting');
  // `capturePending`: el conductor tocó verificar → desmontamos la preview para liberar la cámara y, tras el
  // handoff, disparamos la captura nativa. Mantiene el sensor sin conflicto (preview ↔ grabber de liveness).
  const [capturePending, setCapturePending] = useState(false);

  const success = banner?.tone === 'success';
  const capturing = loading || capturePending;
  // Encuadrando: ni capturando ni con éxito ni bloqueado. Solo acá vive la preview en vivo.
  const framing = !capturing && !success && !disabled;
  const showPreview = framing && cameraState !== 'error';
  const cameraReady = cameraState === 'ready';

  const handleCameraReady = useCallback(() => setCameraState('ready'), []);
  const handleCameraError = useCallback(
    (_payload: BiometricCameraErrorPayload) => setCameraState('error'),
    [],
  );

  // Al volver a encuadrar (tras un fallo/reintento) reseteamos la cámara para re-montar la preview.
  useEffect(() => {
    if (framing && !capturePending) {
      setCameraState((prev) => (prev === 'error' ? prev : 'starting'));
    }
    // solo al entrar/salir de framing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framing]);

  // Handoff: tras desmontar la preview (capturePending oculta la cámara), esperamos a que el sensor se
  // libere y recién ahí disparamos la captura nativa. Ref para no re-registrar el timer.
  const captureRef = useRef(onCapture);
  captureRef.current = onCapture;
  useEffect(() => {
    if (!capturePending) {
      return;
    }
    const id = setTimeout(() => {
      captureRef.current();
      setCapturePending(false);
    }, CAMERA_HANDOFF_MS);
    return () => clearTimeout(id);
  }, [capturePending]);

  // CTA: con cámara lista → handoff (desmontar preview → capturar). Con cámara caída → captura directa
  // (degradación honesta, el liveness no necesita la preview). Iniciando → el botón está deshabilitado.
  const onCta = useCallback(() => {
    if (cameraReady) {
      setCapturePending(true);
    } else if (cameraState === 'error') {
      captureRef.current();
    }
  }, [cameraReady, cameraState]);

  const ctaDisabled = disabled || (framing && cameraState === 'starting');

  return (
    <SafeScreen
      scroll
      header={
        <View style={styles.header}>
          <IconButton
            accessibilityLabel={topTitle}
            variant="surface"
            size="md"
            icon={<IconChevronLeft size={22} color={theme.colors.ink} />}
            onPress={onBack}
          />
          <Text variant="title3" numberOfLines={1} style={styles.headerTitle}>
            {topTitle}
          </Text>
        </View>
      }
      footer={
        <Button
          label={ctaLabel}
          variant="primary"
          size="lg"
          fullWidth
          loading={capturing}
          disabled={ctaDisabled}
          onPress={onCta}
        />
      }
    >
      <View style={styles.body}>
        {/* Hero editorial a la IZQUIERDA (estándar Tesla, igual que el KYC del alta): título `display`
            + subtítulo muted. El círculo de la cara va centrado aparte (es el foco visual). */}
        <Reveal delay={40} style={styles.intro}>
          <Text variant="display">{heading}</Text>
          <Text variant="callout" color="inkMuted">
            {body}
          </Text>
        </Reveal>

        {/* Zona del círculo: cambia por fase, sin perder el centro. */}
        <Reveal delay={120} spring style={styles.ringArea}>
          {success ? (
            <View style={[styles.circle, styles.centered, { borderColor: theme.colors.success }]}>
              <IconCheck size={64} color={theme.colors.success} strokeWidth={2.4} />
            </View>
          ) : showPreview && cameraReady ? (
            // Cara EN VIVO recortada en círculo (espejada, selfie natural). Se desmonta al capturar.
            <View
              style={[
                styles.circle,
                {
                  borderColor: hexAlpha(theme.colors.accent, 0.6),
                  backgroundColor: theme.colors.bg,
                },
              ]}
            >
              <BiometricCameraPreview
                style={StyleSheet.absoluteFill}
                mirrored
                onCameraReady={handleCameraReady}
                onCameraError={(event) => handleCameraError(event.nativeEvent)}
              />
            </View>
          ) : showPreview ? (
            // La cámara arranca: montamos el nativo (dispara onCameraReady/Error) detrás de un spinner.
            <View style={[styles.circle, styles.centered, { borderColor: theme.colors.border }]}>
              <BiometricCameraPreview
                style={StyleSheet.absoluteFill}
                mirrored
                onCameraReady={handleCameraReady}
                onCameraError={(event) => handleCameraError(event.nativeEvent)}
              />
              <ActivityIndicator size="large" color={theme.colors.accent} />
            </View>
          ) : (
            // Capturando (la cámara la tiene el grabber nativo) o degradado (cámara caída): escudo con halo
            // que respira — se acelera durante la captura. Sin data falsa: no fingimos una preview.
            <View style={styles.centered}>
              <Pulse
                active
                period={capturing ? 900 : 2200}
                minOpacity={0.06}
                maxOpacity={capturing ? 0.26 : 0.14}
                maxScale={capturing ? 1.18 : 1.08}
                style={[styles.halo, { backgroundColor: theme.colors.accent }]}
              >
                {null}
              </Pulse>
              <View
                style={[
                  styles.iconCircle,
                  {
                    backgroundColor: theme.colors.surfaceElevated,
                    borderColor: theme.colors.accent,
                  },
                ]}
              >
                <IconShield size={52} color={theme.colors.accent} strokeWidth={1.8} />
              </View>
            </View>
          )}
        </Reveal>

        {banner ? (
          <Reveal spring style={styles.bannerWrap}>
            <Banner tone={banner.tone} title={banner.title} description={banner.description} />
          </Reveal>
        ) : null}
      </View>
    </SafeScreen>
  );
};

const ICON_CIRCLE = 104;
const HALO = 160;

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  headerTitle: { flexShrink: 1 },
  body: { flex: 1, paddingTop: 12, gap: 24 },
  intro: { gap: 10, marginTop: 12 },
  ringArea: {
    height: RING + 20,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    width: '100%',
  },
  centered: { alignItems: 'center', justifyContent: 'center' },
  circle: {
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 1,
    overflow: 'hidden',
  },
  halo: {
    position: 'absolute',
    width: HALO,
    height: HALO,
    borderRadius: HALO / 2,
    opacity: 0.12,
  },
  iconCircle: {
    width: ICON_CIRCLE,
    height: ICON_CIRCLE,
    borderRadius: ICON_CIRCLE / 2,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerWrap: { marginTop: 4 },
});
