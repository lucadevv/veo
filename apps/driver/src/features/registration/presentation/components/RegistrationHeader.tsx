import React from 'react';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text, useTheme } from '@veo/ui-kit';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft } from '../../../../shared/presentation/icons';
import { PeruFlag, VeoWordmark } from '../../../../shared/presentation/components/VeoWordmark';

interface RegistrationHeaderProps {
  onBack?: () => void;
  /** Muestra el lockup de marca centrado (algunos pasos solo llevan el chevron). */
  showLogo?: boolean;
  /** Variante del logo con alas de velocidad y sello PERÚ. */
  wings?: boolean;
  peru?: boolean;
  /** Muestra "Perú" + bandera en la esquina derecha (drv-07). */
  peruRight?: boolean;
}

/**
 * Cabecera del wizard: chevron de retorno a la izquierda y lockup de marca centrado. El chevron se
 * oculta cuando no hay paso anterior. Mantiene el área táctil ≥44pt del `IconButton`.
 */
export function RegistrationHeader({
  onBack,
  showLogo = true,
  wings = false,
  peru = false,
  peruRight = false,
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
        {showLogo ? <VeoWordmark size="sm" showRoute={wings} peru={peru} /> : null}
      </View>
      <View style={[styles.side, styles.right]}>
        {peruRight ? (
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
