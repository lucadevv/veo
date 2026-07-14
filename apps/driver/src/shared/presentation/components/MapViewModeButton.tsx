import { IconButton, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useMapViewModeStore } from '../stores/mapViewModeStore';

export interface MapViewModeButtonProps {
  /**
   * Distancia (px) desde el borde superior de la pantalla (el caller suma su safe-area + el alto del
   * chrome que flota arriba — el banner de maniobras en el viaje — para no chocar con él).
   */
  topInset: number;
}

/**
 * Toggle flotante 2D/3D del mapa (espejo 1:1 del pasajero — `MapViewModeButton` de passenger, misma
 * identidad Trust): círculo blanco (`IconButton` variant surface + sombra suave level2), anclado
 * arriba-derecha bajo el chrome. El GLYPH muestra el modo DESTINO ("2D" visible cuando estás en 3D,
 * como el toggle de Google Maps): tocar te lleva a lo que lee el botón. La preferencia vive en
 * `useMapViewModeStore` (persistida en MMKV) y la consume el `AppMap` (estilo + pitch de navegación).
 */
export function MapViewModeButton({ topInset }: MapViewModeButtonProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const mode = useMapViewModeStore((s) => s.mode);
  const toggle = useMapViewModeStore((s) => s.toggle);
  const targetLabel = mode === '3d' ? '2D' : '3D';
  return (
    <View style={[styles.anchor, { top: topInset, right: theme.spacing.lg }]} pointerEvents="box-none">
      <IconButton
        accessibilityLabel={mode === '3d' ? t('navigation.mapView2d') : t('navigation.mapView3d')}
        variant="surface"
        onPress={toggle}
        icon={
          <Text variant="footnote" color="ink" style={styles.glyph}>
            {targetLabel}
          </Text>
        }
        style={{ ...theme.elevation.level2 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute' },
  // Glyph tipográfico "2D"/"3D": peso alto + tracking corto para leerse como ícono, no como texto.
  glyph: { fontWeight: '700', letterSpacing: 0.4 },
});
