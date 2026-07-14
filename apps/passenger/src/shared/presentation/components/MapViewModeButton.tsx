import {IconButton, Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {useMapViewModeStore} from '../stores/mapViewModeStore';

export interface MapViewModeButtonProps {
  /**
   * Distancia (px) desde el borde superior de la pantalla (el caller suma su safe-area + el alto del
   * chrome que flota arriba — SOS/EN VIVO en el viaje, pill del Home fuera de él — para no chocar).
   */
  topInset: number;
}

/**
 * Toggle flotante 2D/3D del mapa (pedido del dueño): círculo blanco estilo Trust (mismo `IconButton`
 * variant surface + sombra suave que el RecenterButton, el otro control flotante del mapa), anclado
 * arriba-derecha bajo el chrome. El GLYPH muestra el modo DESTINO ("2D" visible cuando estás en 3D,
 * como el toggle de Google Maps): tocar te lleva a lo que lee el botón. La preferencia vive en
 * `useMapViewModeStore` (persistida en MMKV) y la consume el `AppMap` (estilo + pitch).
 */
export function MapViewModeButton({
  topInset,
}: MapViewModeButtonProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const mode = useMapViewModeStore(s => s.mode);
  const toggle = useMapViewModeStore(s => s.toggle);
  const targetLabel = mode === '3d' ? '2D' : '3D';
  return (
    <View
      style={[styles.anchor, {top: topInset, right: theme.spacing.lg}]}
      pointerEvents="box-none">
      <IconButton
        accessibilityLabel={
          mode === '3d' ? t('home.mapView2d') : t('home.mapView3d')
        }
        variant="surface"
        onPress={toggle}
        icon={
          <Text variant="footnote" color="ink" style={styles.glyph}>
            {targetLabel}
          </Text>
        }
        style={{...theme.elevation.level2}}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {position: 'absolute'},
  // Glyph tipográfico "2D"/"3D": peso alto + tracking corto para leerse como ícono, no como texto.
  glyph: {fontWeight: '700', letterSpacing: 0.4},
});
