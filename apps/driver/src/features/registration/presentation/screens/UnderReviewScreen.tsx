import React, { useEffect } from 'react';
import { Linking, RefreshControl, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Banner, Button, SafeScreen, Text, useReducedMotion, useTheme } from '@veo/ui-kit';
import type { DriverProfileView } from '@veo/api-client';
import { useRegistrationGate } from '../hooks/useRegistrationGate';
import {
  IconAccount,
  IconCar,
  IconCheck,
  IconDocument,
  IconLifebuoy,
} from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { env } from '../../../../core/config/env';
import { useRegistrationExit } from '../hooks/useRegistrationExit';
import { useRegistrationExitGuard } from '../hooks/useRegistrationExitGuard';
import { RegistrationExitSheet, VeoWordmark, hexAlpha } from '../components';

/** Ícono de KYC (rostro escaneado) para la fila de identidad/biometría. */
function ScanFaceGlyph({ color, size = 22 }: { color: string; size?: number }): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <Circle cx={12} cy={11} r={2.5} stroke={color} strokeWidth={2} />
      <Path d="M8.5 16a4 4 0 0 1 7 0" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

/** Ilustración de portapapeles con checks + reloj (line art cian) de la pantalla de revisión. */
function ReviewClipboard({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={132} height={132} viewBox="0 0 132 132" fill="none">
      <Rect x={26} y={20} width={70} height={92} rx={8} stroke={color} strokeWidth={2.4} />
      <Rect x={48} y={12} width={26} height={16} rx={5} stroke={color} strokeWidth={2.4} />
      <Circle cx={61} cy={46} r={9} stroke={color} strokeWidth={2.4} />
      <Path d="M40 70h26M40 82h20" stroke={color} strokeWidth={2.4} strokeLinecap="round" />
      <Path
        d="M38 70l3 3 5-6M38 82l3 3 5-6"
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={96} cy={92} r={20} stroke={color} strokeWidth={2.4} fill="none" />
      <Path
        d="M96 82v10l6 4"
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * Checklist REAL del alta derivado del perfil del gate (server-truth), NO hardcodeado. El modelo se
 * invierte respecto al diseño viejo: las 4 cosas que el conductor ENVIÓ están COMPLETAS (✓ verde) y lo
 * único "en curso" es la revisión del equipo VEO. Degrada con seguridad si el perfil aún no resolvió
 * (cache miss): el conductor está en `in_review` por definición, así que ese es el PISO de cada check
 * (no inventamos datos; reflejamos lo que el backend ya garantizó para llegar acá).
 */
interface ReviewChecks {
  personal: boolean;
  vehicle: boolean;
  documents: boolean;
  identity: boolean;
}

function deriveReviewChecks(profile: DriverProfileView | undefined): ReviewChecks {
  // Piso: estar en `in_review` implica (mapProfileToRegistrationStatus) que submittedAllRequired &&
  // biometricEnrolled y que no hay rechazos. Si el perfil está presente, leemos el dato fino; si no,
  // honramos el piso (true) sin fabricar señales que el backend no dio.
  if (!profile) {
    return { personal: true, vehicle: true, documents: true, identity: true };
  }
  const { compliance } = profile;
  return {
    // Datos personales: el conductor existe en el backend (perfil resuelto) ⇒ los completó. No es un
    // literal `done`: deriva de que hay un `driverId` real en el perfil agregado.
    personal: profile.driverId.length > 0,
    // Vehículo: parte de los requeridos enviados (la foto/tarjeta del vehículo viven en el alta). Si no
    // falta ninguno requerido, el vehículo está cargado. Honesto: si faltara, NO mostramos un ✓ falso.
    vehicle: compliance.submittedAllRequired,
    // Documentos: todos los requeridos subidos (a revisión o aprobados).
    documents: compliance.submittedAllRequired,
    // Identidad/biometría: el eje que ANTES mentía (spinner perpetuo). Ahora refleja el enrolamiento real.
    identity: compliance.biometricEnrolled,
  };
}

interface ChecklistRowProps {
  icon: React.ReactNode;
  label: string;
  done: boolean;
  pendingLabel?: string;
  isLast?: boolean;
}

/** Fila del checklist con marcador de timeline a la izquierda (✓ verde = enviado por el conductor). */
function ChecklistRow({
  icon,
  label,
  done,
  pendingLabel,
  isLast,
}: ChecklistRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.checkRow}>
      <View style={styles.timeline}>
        {done ? (
          <View style={[styles.marker, { backgroundColor: theme.colors.success }]}>
            <IconCheck size={13} color={theme.colors.onSuccess} strokeWidth={3} />
          </View>
        ) : (
          // Caso defensivo: un dato que DEBERÍA estar completo en `in_review` no lo está. Lo mostramos
          // honestamente como pendiente (warn), nunca como un ✓ falso.
          <View style={[styles.marker, { backgroundColor: hexAlpha(theme.colors.warn, 0.18) }]}>
            <View style={[styles.dot, { backgroundColor: theme.colors.warn }]} />
          </View>
        )}
        {!isLast ? (
          <View style={[styles.connector, { backgroundColor: theme.colors.border }]} />
        ) : null}
      </View>
      <View style={styles.checkIcon}>{icon}</View>
      <Text variant="bodyStrong" style={styles.checkLabel} numberOfLines={1}>
        {label}
      </Text>
      {done ? (
        <IconCheck size={20} color={theme.colors.success} strokeWidth={2.6} />
      ) : (
        <Text variant="subhead" color="warn">
          {pendingLabel}
        </Text>
      )}
    </View>
  );
}

/**
 * Marcador "latido" del paso ACTIVO (la revisión del equipo VEO). Pulso suave (escala + opacidad de un
 * halo) que comunica "vivo y procesando" sin el `ActivityIndicator` plano que parecía colgado. Respeta
 * reduce-motion: con movimiento reducido queda estático (sin pulso), solo el punto sólido.
 */
function ReviewPulse(): React.JSX.Element {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (reduced) {
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 900, easing: Easing.out(Easing.ease) }),
        withTiming(0, { duration: 900, easing: Easing.in(Easing.ease) }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(pulse);
  }, [pulse, reduced]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.35 - pulse.value * 0.3,
    transform: [{ scale: 1 + pulse.value * 0.6 }],
  }));

  return (
    <View style={styles.pulseWrap}>
      <Animated.View
        style={[styles.pulseHalo, { backgroundColor: theme.colors.accent }, haloStyle]}
      />
      <View style={[styles.pulseCore, { backgroundColor: theme.colors.accent }]} />
    </View>
  );
}

/** Paso ACTIVO: la revisión que está haciendo el equipo VEO (lo único realmente "en curso"). */
function ReviewActiveStep({ label, pending }: { label: string; pending: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.checkRow}>
      <View style={styles.timeline}>
        <View style={[styles.marker, { backgroundColor: hexAlpha(theme.colors.accent, 0.18) }]}>
          <ReviewPulse />
        </View>
      </View>
      <View style={styles.checkIcon}>
        <ScanFaceGlyph color={theme.colors.accent} />
      </View>
      <Text variant="bodyStrong" style={styles.checkLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text variant="subhead" color="accent">
        {pending}
      </Text>
    </View>
  );
}

/**
 * Pantalla "Estamos revisando tus datos" (drv-08). El conductor llega aquí tras enviar el alta
 * (estado `in_review`). El checklist es REAL: deriva del perfil del gate (server-truth) — las 4 cosas que
 * el conductor envió están completas (✓) y lo único en curso es la revisión del equipo VEO (paso activo
 * con latido). "Verificar mi estado" + pull-to-refresh re-consultan `GET /drivers/me`; la transición a
 * `approved`/`rejected` la decide EXCLUSIVAMENTE el backend (vía `useRegistrationGate`).
 *
 * NOTA: `DriverProfileView` NO expone un `submittedAt`/timestamp del envío, así que NO mostramos
 * "Enviado hace X" (degradación honesta: no inventamos una fecha).
 */
export const UnderReviewScreen = (): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { profile, isRefreshing, refreshError, refresh } = useRegistrationGate();

  // Pantalla RAÍZ del estado `in_review`: sin esta salida, el conductor queda atrapado esperando la
  // aprobación sin poder cerrar sesión. Reusa el mismo logout/clearSession + guard del back de hardware.
  const exit = useRegistrationExit();
  useRegistrationExitGuard(exit.handleHardwareBack);

  const checks = deriveReviewChecks(profile);

  const onCheckStatus = () => {
    // RE-CHEQUEA el estado del alta contra el backend (la aprobación NUNCA se hace localmente). Si ya
    // está aprobado, el `useRegistrationGate` re-resuelve y el `RootNavigator` saca al conductor de acá.
    refresh();
  };

  const onContactSupport = () => {
    // El canal de soporte se resuelve desde la configuración de entorno (no hardcodeado en la UI).
    Linking.openURL(`mailto:${env.SUPPORT_EMAIL}`).catch(() => undefined);
  };

  // Etiqueta del botón con feedback de carga/error: idle → "Verificar mi estado"; en vuelo →
  // "Actualizando…"; si el último refresh falló → "Reintentar".
  const checkStatusLabel = isRefreshing
    ? t('registration.review.updating')
    : refreshError
      ? t('registration.review.retry')
      : t('registration.review.checkStatus');

  return (
    <>
      <SafeScreen
        scroll
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={refresh}
            tintColor={theme.colors.accent}
            colors={[theme.colors.accent]}
          />
        }
        footer={
          <View style={{ gap: theme.spacing.sm }}>
            <Button
              label={checkStatusLabel}
              variant="secondary"
              fullWidth
              loading={isRefreshing}
              disabled={isRefreshing}
              onPress={onCheckStatus}
            />
            <Button
              label={t('registration.review.contactSupport')}
              variant="ghost"
              fullWidth
              leftIcon={<IconLifebuoy size={18} color={theme.colors.accent} strokeWidth={2} />}
              onPress={onContactSupport}
            />
            <Button
              label={t('registration.exit')}
              variant="ghost"
              fullWidth
              loading={exit.isLoggingOut}
              onPress={exit.requestExit}
            />
          </View>
        }
      >
        <View style={[styles.body, { gap: theme.spacing.xl }]}>
          <Reveal style={styles.brand}>
            <VeoWordmark size="sm" peru />
          </Reveal>

          <Reveal delay={60} spring style={styles.illustration}>
            <ReviewClipboard color={theme.colors.accent} />
          </Reveal>

          <Reveal delay={120} style={styles.intro}>
            <Text variant="title1" align="center">
              {t('registration.review.title')}
            </Text>
            <Text variant="callout" color="inkMuted" align="center">
              {t('registration.review.subtitle')}
            </Text>
          </Reveal>

          {/* Banner NO bloqueante: un refresh falló pero seguimos mostrando el último estado bueno. */}
          {refreshError ? (
            <Reveal delay={150}>
              <Banner
                tone="warn"
                title={t('registration.review.refreshErrorTitle')}
                description={t('registration.review.refreshErrorBody')}
              />
            </Reveal>
          ) : null}

          <Reveal delay={180}>
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radii.lg,
                  padding: theme.spacing.lg,
                  gap: theme.spacing.lg,
                },
              ]}
            >
              {/* "Vos ya hiciste tu parte": las 4 cosas que el conductor envió (✓ verde, server-truth). */}
              <Text variant="subhead" color="success">
                {t('registration.review.yourPart')}
              </Text>
              <ChecklistRow
                icon={<IconAccount size={22} color={theme.colors.accent} strokeWidth={1.8} />}
                label={t('registration.review.personal')}
                done={checks.personal}
                pendingLabel={t('registration.review.inReview')}
              />
              <ChecklistRow
                icon={<IconCar size={22} color={theme.colors.accent} strokeWidth={1.8} />}
                label={t('registration.review.vehicle')}
                done={checks.vehicle}
                pendingLabel={t('registration.review.inReview')}
              />
              <ChecklistRow
                icon={<IconDocument size={22} color={theme.colors.accent} strokeWidth={1.8} />}
                label={t('registration.review.documents')}
                done={checks.documents}
                pendingLabel={t('registration.review.inReview')}
              />
              <ChecklistRow
                icon={<ScanFaceGlyph color={theme.colors.accent} />}
                label={t('registration.review.identity')}
                done={checks.identity}
                pendingLabel={t('registration.review.inReview')}
                isLast
              />

              <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

              {/* "Ahora nosotros revisamos": el ÚNICO paso realmente en curso (latido). */}
              <Text variant="subhead" color="accent">
                {t('registration.review.ourPart')}
              </Text>
              <ReviewActiveStep
                label={t('registration.review.reviewStep')}
                pending={t('registration.review.reviewStepPending')}
              />
            </View>
          </Reveal>

          {/* Reduce ansiedad: expectativa concreta con el tiempo estimado prominente (no inkMuted). */}
          <Reveal delay={220}>
            <View
              style={[
                styles.etaCard,
                {
                  backgroundColor: hexAlpha(theme.colors.accent, 0.1),
                  borderColor: hexAlpha(theme.colors.accent, 0.25),
                  borderRadius: theme.radii.lg,
                  padding: theme.spacing.lg,
                  gap: theme.spacing.xs,
                },
              ]}
            >
              <Text variant="subhead" color="accent">
                {t('registration.review.etaLabel')}
              </Text>
              <Text variant="title3">{t('registration.review.eta')}</Text>
              <Text variant="callout" color="inkMuted">
                {t('registration.review.etaDetail')}
              </Text>
            </View>
          </Reveal>
        </View>
      </SafeScreen>
      <RegistrationExitSheet exit={exit} />
    </>
  );
};

const styles = StyleSheet.create({
  body: { paddingTop: 16, alignItems: 'stretch' },
  brand: { alignItems: 'center', gap: 6 },
  illustration: { alignItems: 'center' },
  intro: { gap: 8 },
  card: { alignSelf: 'stretch' },
  etaCard: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth },
  divider: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  timeline: { width: 24, alignItems: 'center' },
  marker: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  connector: { position: 'absolute', top: 24, width: 2, height: 26 },
  checkIcon: { width: 26, alignItems: 'center' },
  checkLabel: { flex: 1 },
  pulseWrap: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  pulseHalo: { position: 'absolute', width: 16, height: 16, borderRadius: 8 },
  pulseCore: { width: 8, height: 8, borderRadius: 4 },
});
