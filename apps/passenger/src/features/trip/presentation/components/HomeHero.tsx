import { Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

/**
 * Título HÉROE del Home idle: el ancla visual de la pantalla (fiel a la referencia "Where do you want
 * to go?"). Usa el variant tipográfico más grande del sistema — `displayEditorial` (Fraunces serif
 * 48pt) — para dar un tono editorial y aire arriba, antes de la tarjeta de ruta y los atajos.
 */
export function HomeHero(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  return (
    <View style={[styles.root, { paddingBottom: theme.spacing.xs }]}>
      <Text variant="displayEditorial" color="ink">
        {t('home.heroTitle')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignSelf: 'stretch' },
});
