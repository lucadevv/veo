import React, { useCallback } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@veo/ui-kit';
import type { LatLng } from '../../../../shared/utils/polyline';

export interface ExternalNavButtonsProps {
  /** Destino al que abrir la navegación externa (último punto de la geometría de ruta). */
  destination: LatLng | null;
}

/** Deep link de Waze para navegar a una coordenada. */
export function wazeUrl({ latitude, longitude }: LatLng): string {
  return `waze://?ll=${latitude},${longitude}&navigate=yes`;
}

/** URL universal de Google Maps Directions hacia una coordenada (abre app o web). */
export function googleMapsUrl({ latitude, longitude }: LatLng): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}`;
}

/**
 * Fallback de navegación externa: abre el destino del viaje en Waze o Google Maps vía deep link.
 * Es un APOYO (la app prioriza el banner de maniobra propio); por eso son botones secundarios.
 * Waze intenta el esquema nativo y, si no está instalado, cae a Google Maps (URL universal que el SO
 * resuelve a app o navegador). No se renderiza si aún no hay coordenada de destino.
 */
export function ExternalNavButtons({
  destination,
}: ExternalNavButtonsProps): React.JSX.Element | null {
  const { t } = useTranslation();

  const openWaze = useCallback(async () => {
    if (!destination) {
      return;
    }
    const waze = wazeUrl(destination);
    const canWaze = await Linking.canOpenURL(waze);
    await Linking.openURL(canWaze ? waze : googleMapsUrl(destination));
  }, [destination]);

  const openGoogle = useCallback(() => {
    if (!destination) {
      return;
    }
    return Linking.openURL(googleMapsUrl(destination));
  }, [destination]);

  if (!destination) {
    return null;
  }

  return (
    <View style={styles.row}>
      <Button
        label={t('navigation.openWaze')}
        variant="secondary"
        size="sm"
        fullWidth
        onPress={openWaze}
        style={styles.item}
      />
      <Button
        label={t('navigation.openGoogleMaps')}
        variant="secondary"
        size="sm"
        fullWidth
        onPress={openGoogle}
        style={styles.item}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12 },
  item: { flex: 1 },
});
