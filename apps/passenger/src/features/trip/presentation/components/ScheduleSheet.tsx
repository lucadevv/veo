import {BottomSheet, Button, Text, useTheme} from '@veo/ui-kit';
import React, {useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, View} from 'react-native';
import {formatClock} from '../../../../shared/utils/format';
import {SelectableChip} from '../../../../shared/presentation/components/SelectableChip';
import {
  type DayOption,
  scheduleDayOptions,
  timeSlotsForDay,
} from '../../domain/scheduleSlots';

export interface ScheduleSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Devuelve la fecha/hora elegida (epoch ms) ya validada en ventana [≥15min, ≤7días]. */
  onConfirm: (epochMs: number) => void;
}

/** Etiquetas cortas de día de semana en es-PE (0=domingo). */
const WEEKDAY_LABELS = [
  'Dom',
  'Lun',
  'Mar',
  'Mié',
  'Jue',
  'Vie',
  'Sáb',
] as const;

/**
 * Selector propio de fecha/hora para VIAJES PROGRAMADOS (no hay date-picker en el ui-kit). Diseño
 * limpio tipo "chips de día + chips de hora": el usuario elige un día dentro de la ventana de 7
 * días y luego una hora en pasos de 15 min; solo se ofrecen horarios válidos (≥15 min de
 * anticipación), por lo que el resultado SIEMPRE cae en la ventana y el CTA no puede producir un
 * `scheduledFor` inválido. El backend revalida igual.
 */
export function ScheduleSheet({
  visible,
  onClose,
  onConfirm,
}: ScheduleSheetProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  // Días/horas se calculan a partir del momento en que se abre el sheet (estable mientras está abierto).
  const days = useMemo<DayOption[]>(
    () => (visible ? scheduleDayOptions(new Date()) : []),
    [visible],
  );

  const [dayStart, setDayStart] = useState<number | null>(null);
  const [slot, setSlot] = useState<number | null>(null);

  // Día efectivo: el elegido o el primero disponible.
  const activeDayStart = dayStart ?? days[0]?.startOfDay ?? null;

  const slots = useMemo<number[]>(
    () =>
      activeDayStart !== null
        ? timeSlotsForDay(activeDayStart, new Date())
        : [],
    [activeDayStart],
  );

  const dayLabel = (day: DayOption, index: number): string => {
    if (index === 0) {
      return t('schedule.today');
    }
    if (index === 1) {
      return t('schedule.tomorrow');
    }
    return `${WEEKDAY_LABELS[day.weekday]} ${day.dayOfMonth}`;
  };

  const reset = (): void => {
    setDayStart(null);
    setSlot(null);
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={() => {
        reset();
        onClose();
      }}
      title={t('schedule.title')}
      footer={
        <Button
          label={t('schedule.confirm')}
          fullWidth
          disabled={slot === null}
          onPress={() => {
            if (slot !== null) {
              onConfirm(slot);
              reset();
            }
          }}
        />
      }>
      <View style={{gap: theme.spacing.lg}}>
        <Text variant="callout" color="inkMuted">
          {t('schedule.subtitle')}
        </Text>

        <View style={{gap: theme.spacing.sm}}>
          <Text variant="subhead" color="inkMuted">
            {t('schedule.day')}
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{gap: theme.spacing.sm}}>
            {days.map((day, index) => (
              <SelectableChip
                key={day.startOfDay}
                label={dayLabel(day, index)}
                selected={day.startOfDay === activeDayStart}
                onPress={() => {
                  setDayStart(day.startOfDay);
                  setSlot(null);
                }}
              />
            ))}
          </ScrollView>
        </View>

        <View style={{gap: theme.spacing.sm}}>
          <Text variant="subhead" color="inkMuted">
            {t('schedule.time')}
          </Text>
          <View style={styles.slotGrid}>
            {slots.map(ts => (
              <SelectableChip
                key={ts}
                label={formatClock(ts)}
                selected={ts === slot}
                onPress={() => setSlot(ts)}
                tabular
              />
            ))}
          </View>
        </View>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  slotGrid: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
});
