import React from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Svg, { Defs, RadialGradient, Stop, Rect } from 'react-native-svg';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { useRegistrationGate } from '../hooks/useRegistrationGate';
import { IconLifebuoy, IconShield } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { env } from '../../../../core/config/env';
import { useRegistrationExit } from '../hooks/useRegistrationExit';
import { useRegistrationExitGuard } from '../hooks/useRegistrationExitGuard';
import { RegistrationExitSheet } from '../components';
import { hexAlpha } from '../../../../shared/presentation/color';

/** Diámetro del glow radial ambiente detrás del badge (frame `C/UnderReview`: rect 320 con gradiente radial). */
const GLOW = 320;
/** Diámetro del badge del escudo (frame: 88, círculo pleno). */
const BADGE = 88;

/**
 * Pantalla "Estamos revisando tus datos" (drv-08), a imagen del frame `C/UnderReview` (dirección Tesla:
 * CALMA y ESPACIO, composición CENTRADA). El conductor llega tras enviar el alta (`in_review`). En vez del
 * timeline de checks (que se sentía "hecho por AI"), una composición espartana y SIMÉTRICA: wordmark +
 * badge de escudo con glow radial azul + título grande `display` centrado + una línea que tranquiliza + el
 * tiempo estimado en una card destacada. "Actualizar estado" re-consulta `GET /drivers/me`; la transición
 * a `approved`/`rejected` la decide EXCLUSIVAMENTE el backend (`useRegistrationGate`). Sin pulsos animados.
 */
export const UnderReviewScreen = (): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { isRefreshing, refreshError, refresh } = useRegistrationGate();

  // Pantalla RAÍZ del estado `in_review`: sin esta salida, el conductor queda atrapado esperando la
  // aprobación sin poder cerrar sesión. Reusa el mismo logout/clearSession + guard del back de hardware.
  const exit = useRegistrationExit();
  useRegistrationExitGuard(exit.handleHardwareBack);

  const onCheckStatus = () => {
    // RE-CHEQUEA contra el backend (la aprobación NUNCA se hace localmente). Si ya está aprobado, el
    // `useRegistrationGate` re-resuelve y el `RootNavigator` saca al conductor de acá.
    refresh();
  };

  const onContactSupport = () => {
    // El canal de soporte se resuelve desde la configuración de entorno (no hardcodeado en la UI).
    Linking.openURL(`mailto:${env.SUPPORT_EMAIL}`).catch(() => undefined);
  };

  // Etiqueta con feedback de carga: en vuelo → "Actualizando…"; resto → "Actualizar estado".
  const checkStatusLabel = isRefreshing
    ? t('registration.review.updating')
    : t('registration.actions.refreshStatus');

  return (
    <>
      <SafeScreen
        scroll
        // `padded={false}`: el gutter (24 = `2xl`) lo controla ESTA pantalla, alineado con el footer.
        padded={false}
        footer={
          <View style={{ paddingHorizontal: theme.spacing['2xl'], gap: theme.spacing.md }}>
            {/* 1) Actualizar estado — ÚNICO botón (frame: surface `$surface` + borde `$border-strong`, pill). */}
            <Button
              label={checkStatusLabel}
              variant="secondary"
              fullWidth
              loading={isRefreshing}
              disabled={isRefreshing}
              onPress={onCheckStatus}
            />
            {/* 2) Contactar a soporte — FILA text-link (frame: icon + texto en `$ink-muted`, SIN chrome de
                botón). No es un Button: en el diseño es un link discreto. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('registration.support.contact')}
              onPress={onContactSupport}
              style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
            >
              <IconLifebuoy size={16} color={theme.colors.inkMuted} strokeWidth={2} />
              <Text variant="subhead" color="inkMuted">
                {t('registration.support.contact')}
              </Text>
            </Pressable>
            {/* 3) Cerrar sesión — link QUIETO en `$ink-subtle` (menor peso, para no tocarlo por error). */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('registration.exit')}
              disabled={exit.isLoggingOut}
              onPress={exit.requestExit}
              style={({ pressed }) => [styles.logoutRow, pressed && styles.pressed]}
            >
              {exit.isLoggingOut ? (
                <ActivityIndicator size="small" color={theme.colors.inkSubtle} />
              ) : (
                <Text variant="footnote" color="inkSubtle">
                  {t('registration.exit')}
                </Text>
              )}
            </Pressable>
          </View>
        }
      >
        <View
          style={[
            styles.body,
            { gap: theme.spacing['2xl'], paddingHorizontal: theme.spacing['2xl'] },
          ]}
        >
          {/* Wordmark CENTRADO arriba — "VEO" PELADO (frame `Brand`: display 18/700, letterSpacing 1.5).
              NO el lockup completo `VeoWordmark` (VEO/CONDUCTORES/PERÚ), que carga de más esta pantalla. */}
          <Reveal style={styles.brand}>
            <Text variant="title2" style={styles.wordmark}>
              VEO
            </Text>
          </Reveal>

          {/* Badge del escudo con GLOW radial azul detrás (frame `rnaFy`: rect 320 gradiente `$accent` #0075A9
              0.15→0 + círculo 88 tint `$info` #0097CE con shield-check 40 `$info`). El glow ambiente sigue
              siendo brand/accent; el ESCUDO y su disco son info-cyan (no brand). El glow es un rect SVG con
              RadialGradient real, no un shadow. */}
          <Reveal delay={60} style={styles.badgeSection}>
            <View style={styles.glow} pointerEvents="none">
              <Svg width={GLOW} height={GLOW}>
                <Defs>
                  <RadialGradient
                    id="badgeGlow"
                    cx={GLOW / 2}
                    cy={GLOW / 2}
                    r={GLOW / 2}
                    gradientUnits="userSpaceOnUse"
                  >
                    <Stop offset="0" stopColor={theme.colors.accent} stopOpacity={0.16} />
                    <Stop offset="1" stopColor={theme.colors.accent} stopOpacity={0} />
                  </RadialGradient>
                </Defs>
                <Rect width={GLOW} height={GLOW} fill="url(#badgeGlow)" />
              </Svg>
            </View>
            <View style={[styles.badge, { backgroundColor: hexAlpha(theme.colors.info, 0.14) }]}>
              <IconShield size={40} color={theme.colors.info} strokeWidth={2} />
            </View>
          </Reveal>

          {/* Bloque héroe CENTRADO (frame): título `display` 30/700 en 2 líneas + subtítulo muted. */}
          <Reveal delay={100} style={styles.intro}>
            <Text variant="title1" align="center">
              {t('registration.review.title')}
            </Text>
            <Text variant="callout" color="inkMuted" align="center">
              {t('registration.review.subtitle')}
            </Text>
          </Reveal>

          {/* Banner NO bloqueante: un refresh falló pero seguimos mostrando el último estado bueno. */}
          {refreshError ? (
            <Reveal delay={140}>
              <Banner
                tone="warn"
                title={t('registration.review.refreshErrorTitle')}
                description={t('registration.review.refreshErrorBody')}
              />
            </Reveal>
          ) : null}

          {/* Card del tiempo estimado (frame `rnaFy` EtaCard: fill `$warn` #FFA000 tint + stroke `#FFA0004D`,
              r-lg, padding 16/18, gap 6). Texto interno a la IZQUIERDA: label warn 12/600, valor display
              20/700, nota muted 13. Ámbar (no brand): "espera" comunica paciencia, no acción. */}
          <Reveal delay={180}>
            <View
              style={[
                styles.etaCard,
                {
                  backgroundColor: hexAlpha(theme.colors.warn, 0.14),
                  borderColor: hexAlpha(theme.colors.warn, 0.3),
                  borderRadius: theme.radii.lg,
                },
              ]}
            >
              <Text variant="caption" color="warn" style={styles.etaLabel}>
                {t('registration.review.etaLabel')}
              </Text>
              <Text variant="title2" style={styles.etaValue}>
                {t('registration.review.eta')}
              </Text>
              <Text variant="footnote" color="inkMuted">
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
  body: { paddingTop: 24, alignItems: 'stretch' },
  // Wordmark centrado (frame).
  brand: { alignSelf: 'center' },
  // "VEO" pelado: display a 18 con tracking (title2 es 24 → override a 18/1.5).
  wordmark: { fontSize: 18, letterSpacing: 1.5 },
  // Sección del badge: centrada; el glow (320) desborda por absoluto detrás del círculo (88).
  badgeSection: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    height: BADGE,
  },
  glow: {
    position: 'absolute',
    width: GLOW,
    height: GLOW,
    top: '50%',
    left: '50%',
    marginTop: -GLOW / 2,
    marginLeft: -GLOW / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    width: BADGE,
    height: BADGE,
    borderRadius: BADGE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Bloque héroe CENTRADO.
  intro: { gap: 10, alignSelf: 'stretch', alignItems: 'center' },
  // Card ETA: stroke 1px + padding vertical 16 / horizontal 18 + gap 6 (frame).
  etaCard: {
    alignSelf: 'stretch',
    borderWidth: 1,
    paddingVertical: 16,
    paddingHorizontal: 18,
    gap: 6,
  },
  etaLabel: { letterSpacing: 0.5 },
  // El valor del frame es 20 (title2 es 24) → override a 20/26.
  etaValue: { fontSize: 20, lineHeight: 26 },
  // Filas text-link del footer (frame: Support icon+texto centrado, Logout texto quieto).
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
  },
  logoutRow: { alignItems: 'center', justifyContent: 'center', paddingTop: 4, paddingVertical: 8 },
  pressed: { opacity: 0.6 },
});
