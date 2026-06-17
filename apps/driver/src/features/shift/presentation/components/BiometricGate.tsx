import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Banner, Button, IconButton, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { IconChevronLeft, IconShield } from '../../../../shared/presentation/icons';
import { Appear, Pulse } from './motion';

/** Aviso de resultado del flujo biométrico (mismo contrato que `Banner`). */
export interface BiometricGateBanner {
  tone: 'warn' | 'danger' | 'info' | 'success';
  title: string;
  description?: string;
}

export interface BiometricGateProps {
  /** Título de la barra superior. */
  topTitle: string;
  /** Titular grande centrado (qué se va a hacer). */
  heading: string;
  /** Texto explicativo del proceso. */
  body: string;
  /** Aviso de resultado (éxito/fallo/bloqueo); `null` para no mostrar nada. */
  banner: BiometricGateBanner | null;
  /** Texto del botón de captura (lo decide el flujo según su fase). */
  ctaLabel: string;
  /** Estado de carga del flujo: deshabilita y muestra spinner. */
  loading: boolean;
  /** Deshabilita el CTA sin spinner (p. ej. bloqueo biométrico de 1h: no se puede reintentar todavía). */
  disabled?: boolean;
  /** Dispara la captura biométrica (cableado al hook del flujo). */
  onCapture: () => void;
  /** Retroceso de navegación. */
  onBack: () => void;
}

/**
 * Scaffold premium compartido para el gate biométrico (inicio de turno y enrolamiento).
 * Es puramente presentacional: la lógica/hooks viven en cada pantalla. Mantiene ambas vistas
 * visualmente coherentes (escudo con halo cian, titular, explicación, aviso y CTA fija inferior).
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
          loading={loading}
          disabled={disabled}
          onPress={onCapture}
        />
      }
    >
      <View style={[styles.body, { paddingTop: theme.spacing['3xl'] }]}>
        {/* Escudo en círculo de superficie con halo cian que respira (lenguaje Midnight Motion).
            El halo se acelera/intensifica durante la captura y el escudo late solo en ese momento;
            la lógica biométrica no cambia. */}
        <View style={styles.haloWrap}>
          <Pulse
            active
            period={loading ? 900 : 2200}
            minOpacity={0.06}
            maxOpacity={loading ? 0.26 : 0.16}
            maxScale={loading ? 1.18 : 1.1}
            style={[styles.haloGlow, { backgroundColor: theme.colors.accent }]}
          >
            {null}
          </Pulse>
          <Pulse active={loading} period={1100} minOpacity={1} maxScale={1.04}>
            <View
              style={[
                styles.iconCircle,
                { backgroundColor: theme.colors.surfaceElevated, borderColor: theme.colors.accent },
              ]}
            >
              <IconShield size={52} color={theme.colors.accent} strokeWidth={1.8} />
            </View>
          </Pulse>
        </View>

        <Appear
          delay={80}
          style={[styles.copy, { marginTop: theme.spacing['2xl'], gap: theme.spacing.sm }]}
        >
          <Text variant="title2" align="center">
            {heading}
          </Text>
          <Text variant="callout" color="inkMuted" align="center" style={styles.bodyText}>
            {body}
          </Text>
        </Appear>

        {banner ? (
          <Appear style={{ marginTop: theme.spacing['2xl'] }}>
            <Banner tone={banner.tone} title={banner.title} description={banner.description} />
          </Appear>
        ) : null}
      </View>
    </SafeScreen>
  );
};

const HALO = 132;
const ICON_CIRCLE = 104;

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  headerTitle: { flexShrink: 1 },
  body: { flex: 1, alignItems: 'center' },
  haloWrap: {
    width: HALO,
    height: HALO,
    alignItems: 'center',
    justifyContent: 'center',
  },
  haloGlow: {
    ...StyleSheet.absoluteFill,
    borderRadius: HALO / 2,
    // Opacidad baja: tiñe el lienzo oscuro como un resplandor cian sin lavar el fondo.
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
  copy: { alignItems: 'center' },
  bodyText: { maxWidth: 320 },
});
