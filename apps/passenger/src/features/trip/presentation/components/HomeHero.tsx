import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';

export interface HomeHeroProps {
  /** Primer nombre del pasajero para el saludo. `null` → saludo sin nombre. */
  name: string | null;
}

/**
 * Saludo HÉROE del Home idle (fiel a `design/veo.pen` SearchSheet): "Hola, {nombre}" + subtítulo
 * cálido de seguridad. Reemplaza el título editorial "¿A dónde vamos?" por el saludo personal del
 * .pen (el "¿a dónde?" ahora vive en el buscador). Ancla visual + aire arriba, antes del toggle.
 */
export function HomeHero({name}: HomeHeroProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const greeting = name ? `${t('home.greeting')}, ${name}` : t('home.greeting');

  return (
    <View style={[styles.root, {gap: theme.spacing.xxs}]}>
      {/* Fiel a design/veo.pen P/Home (Greeting LMOuo): 24px (title2), no 30 (title1). */}
      <Text variant="title2" color="ink">
        {greeting}
      </Text>
      {/* Sub (ma19u): Outfit 14 → callout, no body (16). */}
      <Text variant="callout" color="inkMuted">
        {t('home.greetingSub')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {alignSelf: 'stretch'},
});
