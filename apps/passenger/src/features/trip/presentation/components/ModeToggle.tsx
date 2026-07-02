import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';
import {IconBolt, IconClock} from './icons';

/** Modo temporal del pedido: inmediato o programado (design/veo.pen ModeToggle). Constante tipada,
 *  no string mágico — el contenedor compara contra `TripTimeMode.Scheduled` para rutear. */
export const TripTimeMode = {Now: 'now', Scheduled: 'scheduled'} as const;
export type TripTimeMode = (typeof TripTimeMode)[keyof typeof TripTimeMode];

export interface ModeToggleProps {
  value: TripTimeMode;
  onChange: (mode: TripTimeMode) => void;
}

interface SegmentProps {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
}

function Segment({active, label, icon, onPress}: SegmentProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{selected: active}}
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.segment,
        {
          borderRadius: theme.radii.pill,
          backgroundColor: active ? `${theme.colors.brand}26` : 'transparent',
        },
      ]}>
      {icon}
      <Text
        variant="subhead"
        style={{
          color: active ? theme.colors.brand : theme.colors.inkSubtle,
          fontWeight: '600',
        }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Segmented "Ahora / Programado" del sheet del Home (fiel a `design/veo.pen` ModeToggle): el segmento
 * activo se rellena en azul de marca tenue + texto/ícono de marca; el inactivo queda en `inkSubtle`.
 * No decide la lógica del viaje — emite el modo elegido y el contenedor rutea (Programado → flujo
 * programado real vía `onScheduled`). La UI no autoriza ni ejecuta, solo refleja.
 */
export function ModeToggle({
  value,
  onChange,
}: ModeToggleProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const isNow = value === TripTimeMode.Now;
  return (
    <View
      style={[
        styles.track,
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.pill,
        },
      ]}>
      <Segment
        active={isNow}
        label={t('home.modeNow')}
        icon={
          <IconBolt
            color={isNow ? theme.colors.brand : theme.colors.inkSubtle}
            size={16}
          />
        }
        onPress={() => onChange(TripTimeMode.Now)}
      />
      <Segment
        active={!isNow}
        label={t('home.modeScheduled')}
        icon={
          <IconClock
            color={!isNow ? theme.colors.brand : theme.colors.inkSubtle}
            size={16}
          />
        }
        onPress={() => onChange(TripTimeMode.Scheduled)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {flexDirection: 'row', gap: 4, padding: 4},
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 11,
  },
});
