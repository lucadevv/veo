import {useNavigation} from '@react-navigation/native';
import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {Pressable, StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {IconArrowLeft} from '../../../features/trip/presentation/components/icons';

export interface ScreenHeaderProps {
  /** Título display de la pantalla (pen: font-display 28/700). */
  title: string;
  /** Subtítulo cálido bajo el título (pen: 15 ink-muted). Opcional. */
  subtitle?: string;
  /** Acción a la derecha del back (p. ej. el engranaje de Avisos). Opcional. */
  trailing?: React.ReactNode;
  /** Chevron de volver. `false` en raíces de TAB (no hay a dónde volver). Default `true`. */
  back?: boolean;
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
  back = true,
}: ScreenHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation();
  return (
    <View style={{gap: theme.spacing.md}}>
      {back || trailing ? (
        <View style={styles.topRow}>
          {/* Back = SOLO el chevron ‹ de iOS (IconArrowLeft ya es un chevron), sin círculo/container: mismo
              back en TODA la app (regla del dueño). Antes iba dentro de un IconButton surface (píldora). */}
          {back ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('actions.back')}
              hitSlop={12}
              onPress={() => navigation.goBack()}>
              <IconArrowLeft color={theme.colors.ink} size={28} />
            </Pressable>
          ) : (
            // Espaciador: mantiene el `trailing` a la derecha (topRow es space-between).
            <View />
          )}
          {trailing ?? null}
        </View>
      ) : null}
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
