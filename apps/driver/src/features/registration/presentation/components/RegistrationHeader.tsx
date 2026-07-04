import React from 'react';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text, useTheme } from '@veo/ui-kit';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft, IconPower } from '../../../../shared/presentation/icons';
import { PeruFlag, VeoWordmark } from '../../../../shared/presentation/components/VeoWordmark';

interface RegistrationHeaderProps {
  onBack?: () => void;
  /** Muestra el lockup de marca centrado (algunos pasos solo llevan el chevron). */
  showLogo?: boolean;
  peru?: boolean;
  /** Muestra "Perú" + bandera en la esquina derecha (drv-07). */
  peruRight?: boolean;
  /**
   * Acción de SALIDA del onboarding (LOTE 1). Cuando se pasa, el header muestra un botón "Cerrar
   * sesión" (ícono de power) arriba-derecha que es la salida de emergencia de las pantallas
   * pre-aprobación. Mutuamente excluyente con `peruRight` (comparten el slot derecho; en la práctica
   * ninguna pantalla usa ambos a la vez). Si se pasan ambos, prevalece `onExit`.
   */
  onExit?: () => void;
}

/**
 * Cabecera del wizard: chevron de retorno a la izquierda y lockup de marca centrado. El chevron se
 * oculta cuando no hay paso anterior. Mantiene el área táctil ≥44pt del `IconButton`.
 */
export function RegistrationHeader({
  onBack,
  showLogo = true,
  peruRight = false,
  onExit,
}: RegistrationHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  return (
    <View style={styles.row}>
      <View style={styles.side}>
        {onBack ? (
          <IconButton
            icon={<IconChevronLeft color={theme.colors.accent} />}
            accessibilityLabel={t('registration.back')}
            variant="plain"
            onPress={onBack}
          />
        ) : null}
      </View>
      <View style={styles.center}>
        {/* Header del wizard: solo "VEO" en blanco, como el frame del pen (no el lockup completo
            "VEO CONDUCTORES" + Perú). `peru` se mantiene en la firma por compatibilidad pero el
            sublabel se apaga acá. */}
        {showLogo ? <VeoWordmark size="sm" veoColor="ink" sublabel={false} /> : null}
      </View>
      <View style={[styles.side, styles.right]}>
        {onExit ? (
          <IconButton
            icon={<IconPower size={22} color={theme.colors.inkMuted} strokeWidth={2} />}
            accessibilityLabel={t('registration.exit')}
            variant="plain"
            onPress={onExit}
          />
        ) : peruRight ? (
          <View style={[styles.peruRight, { gap: theme.spacing.xs }]}>
            <PeruFlag width={18} height={12} />
            <Text variant="caption" color="inkMuted">
              {t('registration.country')}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 48 },
  side: { width: 64, justifyContent: 'center' },
  right: { alignItems: 'flex-end' },
  center: { flex: 1, alignItems: 'center' },
  peruRight: { flexDirection: 'row', alignItems: 'center' },
});
