import React, { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerChangeEvent,
} from '@react-native-community/datetimepicker';
import { Button, Text, useTheme } from '@veo/ui-kit';
import { IconCalendar } from '../icons';

/** Muestra un ISO-8601 (con hora) localizado es-PE, ej. "5 jul 2026, 14:30". Vacío si el ISO no parsea. */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return d.toLocaleString('es-PE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface DateTimeFieldProps {
  label: string;
  /** ISO-8601 completo (con hora) o cadena vacía. */
  value: string;
  /** Emite el ISO-8601 completo (UTC via `toISOString`) al confirmar. */
  onChange: (iso: string) => void;
  placeholder: string;
  error?: string;
  minimumDate?: Date;
  disabled?: boolean;
  containerStyle?: ViewStyle;
}

/**
 * Campo de FECHA + HORA para el viaje programado del carpooling (el DTO exige `fechaHoraSalida` datetime
 * ISO futuro). Espeja el `DateField` canónico —misma caja, mismo sheet iOS aislado en `Modal` (la rueda es
 * frágil inline en Fabric)— pero con `mode="datetime"` y emitiendo el ISO COMPLETO. Android encadena date→time.
 */
export function DateTimeField({
  label,
  value,
  onChange,
  placeholder,
  error,
  minimumDate,
  disabled = false,
  containerStyle,
}: DateTimeFieldProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [iosSheetVisible, setIosSheetVisible] = useState(false);
  const [tempDate, setTempDate] = useState<Date | null>(null);

  const parsed = value ? new Date(value) : null;
  const hasValue = parsed !== null && !Number.isNaN(parsed.getTime());
  const displayText = hasValue ? formatDateTime(value) : placeholder;
  const pickerValue = hasValue ? parsed : (minimumDate ?? new Date());
  const borderColor = error ? theme.colors.danger : theme.colors.border;

  const commit = (date: Date) => onChange(date.toISOString());

  const openPicker = () => {
    if (disabled) {
      return;
    }
    if (Platform.OS === 'android') {
      // Android no tiene datetime en un paso: encadenamos fecha → hora.
      DateTimePickerAndroid.open({
        value: pickerValue,
        mode: 'date',
        ...(minimumDate ? { minimumDate } : {}),
        onValueChange: (_e: DateTimePickerChangeEvent, date?: Date) => {
          if (!date) {
            return;
          }
          DateTimePickerAndroid.open({
            value: date,
            mode: 'time',
            onValueChange: (_e2: DateTimePickerChangeEvent, time?: Date) => {
              if (!time) {
                return;
              }
              const merged = new Date(date);
              merged.setHours(time.getHours(), time.getMinutes(), 0, 0);
              commit(merged);
            },
          });
        },
      });
      return;
    }
    setTempDate(pickerValue);
    setIosSheetVisible(true);
  };

  const closeIos = () => {
    setIosSheetVisible(false);
    setTempDate(null);
  };

  const confirmIos = () => {
    if (tempDate) {
      commit(tempDate);
    }
    closeIos();
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={openPicker}
        style={({ pressed }) => [
          styles.box,
          {
            backgroundColor: theme.colors.surface,
            borderColor,
            borderWidth: error ? 2 : 1,
            borderRadius: theme.radii.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
          },
          containerStyle,
        ]}
      >
        <View style={styles.texts}>
          <Text variant="footnote" color="inkMuted">
            {label}
          </Text>
          <Text variant="body" color={hasValue ? 'ink' : 'inkSubtle'} style={styles.value}>
            {displayText}
          </Text>
        </View>
        <IconCalendar size={24} color={theme.colors.accent} strokeWidth={1.8} />
      </Pressable>

      {error ? (
        <Text variant="footnote" color="danger" accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}

      {Platform.OS === 'ios' ? (
        <Modal
          transparent
          visible={iosSheetVisible}
          animationType="slide"
          onRequestClose={closeIos}
          statusBarTranslucent
        >
          <View style={styles.modalRoot}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('common.cancel')}
              style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]}
              onPress={closeIos}
            />
            <View
              accessibilityViewIsModal
              style={[
                styles.sheet,
                {
                  backgroundColor: theme.colors.surface,
                  borderTopLeftRadius: theme.radii.xl,
                  borderTopRightRadius: theme.radii.xl,
                  paddingBottom: insets.bottom + theme.spacing.lg,
                },
              ]}
            >
              <View style={styles.handleArea}>
                <View style={[styles.handle, { backgroundColor: theme.colors.borderStrong }]} />
              </View>
              <View
                style={[
                  styles.sheetHeader,
                  {
                    paddingHorizontal: theme.spacing.lg,
                    paddingVertical: theme.spacing.md,
                    borderBottomColor: theme.colors.border,
                  },
                ]}
              >
                <Button label={t('common.cancel')} variant="ghost" size="sm" onPress={closeIos} />
                <Text variant="bodyStrong" numberOfLines={1} style={styles.sheetTitle}>
                  {label}
                </Text>
                <Button
                  label={t('common.confirm')}
                  variant="ghost"
                  size="sm"
                  onPress={confirmIos}
                />
              </View>
              <DateTimePicker
                value={tempDate ?? pickerValue}
                mode="datetime"
                display="spinner"
                themeVariant={theme.scheme}
                textColor={theme.colors.ink}
                accentColor={theme.colors.accent}
                style={styles.picker}
                {...(minimumDate ? { minimumDate } : {})}
                onValueChange={(_e: DateTimePickerChangeEvent, date?: Date) => {
                  if (date) {
                    setTempDate(date);
                  }
                }}
              />
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', gap: 6 },
  box: { flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'stretch' },
  texts: { flex: 1, gap: 2 },
  value: { marginTop: 2, minHeight: 28, fontWeight: '600' },
  error: { paddingHorizontal: 4 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill },
  sheet: { width: '100%', alignItems: 'center' },
  handleArea: { alignSelf: 'stretch', alignItems: 'center', paddingVertical: 10 },
  handle: { width: 40, height: 5, borderRadius: 999 },
  sheetHeader: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: { flex: 1, textAlign: 'center', marginHorizontal: 8 },
  picker: { alignSelf: 'center', width: '100%', height: 216 },
});
