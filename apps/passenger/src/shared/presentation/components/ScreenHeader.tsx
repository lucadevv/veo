import {useNavigation} from '@react-navigation/native';
import {IconButton, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {IconArrowLeft} from '../../../features/trip/presentation/components/icons';

export interface ScreenHeaderProps {
  /** Título display de la pantalla (pen: font-display 28/700). */
  title: string;
  /** Subtítulo cálido bajo el título (pen: 15 ink-muted). Opcional. */
  subtitle?: string;
  /** Acción a la derecha del back (p. ej. el engranaje de Avisos). Opcional. */
  trailing?: React.ReactNode;
}

/**
 * Header IN-BODY canónico del design/veo.pen (patrón de P/Help y todas las pantallas estándar):
 * back pill (44, surface + borde) + título display + subtítulo. Reemplaza al header NATIVO de
 * React Navigation en las pantallas cuyo contenido pinta su propio título — con ambos, el título
 * salía DUPLICADO (nativo arriba + display en el cuerpo; visto en el barrido pen↔sim). Las rutas
 * que lo adoptan deben declarar `headerShown: false` en el navigator.
 */
export function ScreenHeader({
  title,
  subtitle,
  trailing,
}: ScreenHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation();
  return (
    <View style={{gap: theme.spacing.md}}>
      <View style={styles.topRow}>
        <IconButton
          accessibilityLabel={t('actions.back')}
          variant="surface"
          onPress={() => navigation.goBack()}
          icon={<IconArrowLeft color={theme.colors.ink} size={20} />}
        />
        {trailing ?? null}
      </View>
      <View style={{gap: theme.spacing.xs}}>
        <Text variant="title1">{title}</Text>
        {subtitle ? (
          <Text variant="callout" color="inkMuted">
            {subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
