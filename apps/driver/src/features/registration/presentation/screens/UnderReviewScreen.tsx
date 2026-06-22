import React from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { useRegistrationGate } from '../hooks/useRegistrationGate';
import { IconLifebuoy } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { env } from '../../../../core/config/env';
import { useRegistrationExit } from '../hooks/useRegistrationExit';
import { useRegistrationExitGuard } from '../hooks/useRegistrationExitGuard';
import { RegistrationExitSheet, VeoWordmark, hexAlpha } from '../components';

/**
 * Pantalla "Estamos revisando tus datos" (drv-08), dirección Tesla: CALMA y ESPACIO, no un dashboard.
 * El conductor llega tras enviar el alta (estado `in_review`). En vez del timeline de checks + el latido
 * (que se sentían sobre-diseñados, "hechos por AI"), una composición espartana: wordmark, título grande
 * `display`, una línea que tranquiliza ("ya recibimos todo, ahora revisamos") y el tiempo estimado
 * prominente. "Actualizar estado" re-consulta `GET /drivers/me`; la transición a `approved`/`rejected`
 * la decide EXCLUSIVAMENTE el backend (vía `useRegistrationGate`). Sin pull-to-refresh (la acción única
 * es el botón) ni pulsos animados.
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

  // Etiqueta con feedback de carga: en vuelo → "Actualizando…"; resto → "Actualizar estado" (acción
  // única para re-chequear el estado, mismo término que en todo el onboarding).
  const checkStatusLabel = isRefreshing
    ? t('registration.review.updating')
    : t('registration.actions.refreshStatus');

  return (
    <>
      <SafeScreen
        scroll
        // `padded={false}`: el gutter lo controla ESTA pantalla (24 = `2xl`, gutter editorial de
        // Login/Onboarding). Sin esto, SafeScreen suma su 20 al 24 del body → 44, y el contenido
        // quedaba desalineado del footer (que sí estaba en 20). Una sola fuente de verdad para el gutter.
        padded={false}
        footer={
          <View style={{ paddingHorizontal: theme.spacing['2xl'], gap: theme.spacing.lg }}>
            {/* Cluster de acciones: re-chequear estado + pedir ayuda — lo que el conductor SÍ quiere
                hacer mientras espera. Agrupado y separado de la salida para que no compitan en peso. */}
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
                label={t('registration.support.contact')}
                variant="ghost"
                fullWidth
                leftIcon={<IconLifebuoy size={18} color={theme.colors.accent} strokeWidth={2} />}
                onPress={onContactSupport}
              />
            </View>
            {/* Salida QUIETA: compacta, centrada y separada del cluster, de menor peso visual, para que
                un conductor cansado no toque "Cerrar sesión" por error al querer actualizar el estado. */}
            <View style={{ alignItems: 'center' }}>
              <Button
                label={t('registration.exit')}
                variant="ghost"
                size="sm"
                loading={exit.isLoggingOut}
                onPress={exit.requestExit}
              />
            </View>
          </View>
        }
      >
        <View
          style={[styles.body, { gap: theme.spacing['2xl'], paddingHorizontal: theme.spacing['2xl'] }]}
        >
          <Reveal style={styles.brand}>
            <VeoWordmark size="sm" peru />
          </Reveal>

          {/* Bloque editorial alineado a la izquierda (como onboarding/login): el título manda. */}
          <Reveal delay={80} style={styles.intro}>
            <Text variant="display">{t('registration.review.title')}</Text>
            <Text variant="callout" color="inkMuted">
              {t('registration.review.subtitle')}
            </Text>
          </Reveal>

          {/* Banner NO bloqueante: un refresh falló pero seguimos mostrando el último estado bueno. */}
          {refreshError ? (
            <Reveal delay={120}>
              <Banner
                tone="warn"
                title={t('registration.review.refreshErrorTitle')}
                description={t('registration.review.refreshErrorBody')}
              />
            </Reveal>
          ) : null}

          {/* Único bloque destacado: el tiempo estimado, calmo y concreto (reduce ansiedad). */}
          <Reveal delay={160}>
            <View
              style={[
                styles.etaCard,
                {
                  backgroundColor: hexAlpha(theme.colors.accent, 0.1),
                  borderRadius: theme.radii.lg,
                  padding: theme.spacing.xl,
                  gap: theme.spacing.xs,
                },
              ]}
            >
              <Text variant="subhead" color="accent">
                {t('registration.review.etaLabel')}
              </Text>
              <Text variant="title2">{t('registration.review.eta')}</Text>
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
  body: { paddingTop: 24, alignItems: 'stretch' },
  brand: { alignSelf: 'flex-start' },
  intro: { gap: 10, alignSelf: 'stretch' },
  etaCard: { alignSelf: 'stretch' },
});
