import {IconButton, SosButton, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {IconChevronDown} from './icons';
import {LiveBadge} from './LiveBadge';

export interface TripTopBarProps {
  /** Colapsa el sheet del viaje al peek (design/veo.pen fLKdk MinBtn): despeja el mapa sin cerrar nada. */
  onMinimize: () => void;
  onSos: () => void;
}

/**
 * Chrome del VIAJE ACTIVO sobre el mapa, fiel a design/veo.pen fLKdk: minimizar (izq.), pill "EN VIVO"
 * (centro), SOS (der.). El CHAT ya no vive acá: es una de las 3 acciones del sheet (Mensaje · Compartir
 * · Cancelar) — ver `ActiveTripBody`.
 */
export function TripTopBar({
  onMinimize,
  onSos,
}: TripTopBarProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <>
      <View
        style={[
          styles.tripSos,
          {top: insets.top + theme.spacing.sm, right: theme.spacing.lg},
        ]}>
        <SosButton size={56} onPress={onSos} />
      </View>
      <View
        style={[styles.tripPill, {top: insets.top + theme.spacing.sm}]}
        pointerEvents="none">
        <LiveBadge />
      </View>
      <View
        style={[
          styles.tripMin,
          {top: insets.top + theme.spacing.sm, left: theme.spacing.lg},
        ]}>
        <IconButton
          accessibilityLabel={t('trip.minimize')}
          variant="surface"
          onPress={onMinimize}
          icon={<IconChevronDown color={theme.colors.ink} size={20} />}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // Chrome flotante del viaje activo sobre el mapa.
  tripSos: {position: 'absolute'},
  tripMin: {position: 'absolute'},
  tripPill: {position: 'absolute', left: 0, right: 0, alignItems: 'center'},
});
