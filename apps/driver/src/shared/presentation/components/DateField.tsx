import React, { type ReactNode, useState } from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import DateTimePicker, {
  DateTimePickerAndroid,
  type DateTimePickerChangeEvent,
} from '@react-native-community/datetimepicker';
import { Button, Text, useTheme } from '@veo/ui-kit';
import { IconCalendar } from '../icons';
import { formatShortDate } from '../format';

/** Formato canónico de fecha en la app y en los contratos del backend (`^\d{4}-\d{2}-\d{2}$`). */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Convierte un `YYYY-MM-DD` a un `Date` en HORA LOCAL (mediodía para evitar saltos de día por DST).
 * Ojo: `new Date('YYYY-MM-DD')` interpreta UTC y desfasa el día en husos negativos (Lima = UTC-5),
 * por eso construimos el `Date` con los componentes locales explícitos.
 */
function isoToLocalDate(iso: string): Date | null {
  const match = ISO_DATE.exec(iso);
  if (!match) {
    return null;
  }
  const [, y, m, d] = match;
  return new Date(Number(y), Number(m) - 1, Number(d), 12, 0, 0, 0);
}

/** Convierte un `Date` (en hora local) a su día calendario `YYYY-MM-DD`, sin tocar el huso. */
function localDateToIso(date: Date): string {
  const y = date.getFullYear().toString().padStart(4, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface DateFieldProps {
  /** Etiqueta dentro de la caja (arriba), nunca placeholder-only. */
  label: string;
  /** Valor canónico: fecha en ISO `YYYY-MM-DD`, o cadena vacía si aún no se eligió. */
  value: string;
  /** Notifica el nuevo valor en ISO `YYYY-MM-DD` cuando el conductor confirma una fecha. */
  onChange: (iso: string) => void;
  /** Texto mostrado cuando no hay valor (estado vacío). */
  placeholder: string;
  /** Mensaje de error (ya traducido). Resalta el borde y se anuncia bajo el campo. */
  error?: string;
  /** Fecha mínima seleccionable (p. ej. hoy para vencimientos, 1920 para nacimiento). */
  minimumDate?: Date;
  /** Fecha máxima seleccionable (p. ej. hoy para fecha de nacimiento). */
  maximumDate?: Date;
  /** Fecha que abre el picker cuando aún no hay valor (default: maximumDate o hoy acotado). */
  defaultPickerDate?: Date;
  /** Deshabilita la apertura del picker. */
  disabled?: boolean;
  containerStyle?: ViewStyle;
  /** Ícono de la derecha (default: calendario). Ya coloreado por el consumidor si se pasa. */
  rightIcon?: ReactNode;
}

/**
 * Campo de FECHA canónico del driver app: caja táctil con el look de `RegistrationField`
 * (etiqueta arriba, valor en grande, error debajo, ícono de calendario funcional). Al tocarlo abre
 * el date picker NATIVO (`@react-native-community/datetimepicker`, `mode="date"`):
 *  - iOS: la rueda (`display="spinner"`) vive DENTRO de un bottom sheet modal con acciones
 *    Cancelar/Confirmar. El picker es declarativo y FRÁGIL renderizado inline dentro de un
 *    ScrollView en iOS/Fabric físico (se recorta o parpadea cerrado); por eso lo aislamos en un
 *    `Modal` propio con alto fijo y solo se confirma con la acción explícita.
 *  - Android: API imperativa `DateTimePickerAndroid.open()` (modela mejor el diálogo modal nativo).
 *
 * El valor entra y sale SIEMPRE en ISO `YYYY-MM-DD` (formato canónico de los contratos), y se muestra
 * localizado es-PE vía `formatShortDate`. La validación de reglas de negocio (rango, futuro, fecha real)
 * vive en el dominio: este componente solo acota el picker con `minimumDate`/`maximumDate` y emite ISO.
 */
export function DateField({
  label,
  value,
  onChange,
  placeholder,
  error,
  minimumDate,
  maximumDate,
  defaultPickerDate,
  disabled = false,
  containerStyle,
  rightIcon,
}: DateFieldProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  // Solo aplica a iOS: controla la visibilidad del bottom sheet declarativo. En Android es imperativo.
  const [iosSheetVisible, setIosSheetVisible] = useState(false);
  // Borrador de la rueda en iOS: la rueda actualiza ESTO, no commitea. Se commitea solo al Confirmar.
  const [tempDate, setTempDate] = useState<Date | null>(null);

  const selectedDate = isoToLocalDate(value);
  const hasValue = selectedDate !== null;
  const displayText = hasValue ? formatShortDate(value) : placeholder;

  // Fecha base del picker: el valor actual, si no el default, si no hoy (acotado al rango si aplica).
  const pickerValue = selectedDate ?? defaultPickerDate ?? maximumDate ?? new Date();

  const borderColor = error ? theme.colors.danger : theme.colors.border;

  const handleSet = (date: Date) => {
    onChange(localDateToIso(date));
  };

  const openPicker = () => {
    if (disabled) {
      return;
    }
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: pickerValue,
        mode: 'date',
        ...(minimumDate ? { minimumDate } : {}),
        ...(maximumDate ? { maximumDate } : {}),
        // `onValueChange` solo dispara al confirmar (set); cancelar invoca `onDismiss` (no-op aquí).
        onValueChange: (_event: DateTimePickerChangeEvent, date: Date) => handleSet(date),
      });
      return;
    }
    // iOS: abre el sheet con el borrador inicializado al valor actual del picker.
    setTempDate(pickerValue);
    setIosSheetVisible(true);
  };

  const closeIosSheet = () => {
    setIosSheetVisible(false);
    setTempDate(null);
  };

  // iOS · Confirmar: commitea el borrador como ISO y cierra. Cancelar/backdrop: cierra sin commitear.
  const confirmIos = () => {
    if (tempDate) {
      handleSet(tempDate);
    }
    closeIosSheet();
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        accessibilityValue={hasValue ? { text: displayText } : undefined}
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
        <View style={styles.icon}>
          {rightIcon ?? (
            <IconCalendar size={24} color={theme.colors.accent} strokeWidth={1.8} />
          )}
        </View>
      </Pressable>

      {error ? (
        <Text
          variant="footnote"
          color="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.error}
        >
          {error}
        </Text>
      ) : null}

      {/*
        iOS: bottom sheet propio (NO el `BottomSheet` de ui-kit, cuyo cuerpo es un ScrollView que
        recorta la rueda en Fabric). La rueda actualiza `tempDate`; se confirma/cancela explícitamente.
      */}
      {Platform.OS === 'ios' ? (
        <Modal
          transparent
          visible={iosSheetVisible}
          animationType="slide"
          onRequestClose={closeIosSheet}
          statusBarTranslucent
        >
          <View style={styles.modalRoot}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('common.cancel')}
              style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]}
              onPress={closeIosSheet}
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
              {/* Grabber: barra redondeada centrada arriba, mismo look que el BottomSheet de ui-kit. */}
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
                <Button
                  label={t('common.cancel')}
                  variant="ghost"
                  size="sm"
                  accessibilityLabel={t('common.cancel')}
                  onPress={closeIosSheet}
                />
                <Text variant="bodyStrong" color="ink" numberOfLines={1} style={styles.sheetTitle}>
                  {label}
                </Text>
                <Button
                  label={t('common.confirm')}
                  variant="ghost"
                  size="sm"
                  accessibilityLabel={t('common.confirm')}
                  onPress={confirmIos}
                />
              </View>

              <DateTimePicker
                value={tempDate ?? pickerValue}
                mode="date"
                display="spinner"
                // iOS · contraste en modo noche: el driver app es dark-by-default. Derivamos la
                // apariencia del picker del `scheme` del tema (no hardcode) y pintamos el texto de la
                // rueda con `ink` para que contraste sobre el sheet dark. NOTA (v9.1.0 index.d.ts):
                // `textColor` solo aplica con display="spinner" (es nuestro caso) y `accentColor`
                // NO tiene efecto con spinner — se pasa igual por consistencia/futuro cambio de display.
                themeVariant={theme.scheme}
                textColor={theme.colors.ink}
                accentColor={theme.colors.accent}
                style={styles.picker}
                {...(minimumDate ? { minimumDate } : {})}
                {...(maximumDate ? { maximumDate } : {})}
                onValueChange={(_event: DateTimePickerChangeEvent, date: Date) => {
                  // Actualiza SOLO el borrador. No commitea ni cierra en cada giro de la rueda.
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
  icon: { alignItems: 'center', justifyContent: 'center' },
  error: { paddingHorizontal: 4 },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill },
  // El cuerpo del sheet centra la rueda horizontalmente (la rueda nativa no se autocenta en Fabric).
  sheet: { width: '100%', alignItems: 'center' },
  // Grabber centrado (width 40 · height 5 · pill), idéntico al del BottomSheet de ui-kit.
  handleArea: { alignSelf: 'stretch', alignItems: 'center', paddingVertical: 10 },
  handle: { width: 40, height: 5, borderRadius: 999 },
  sheetHeader: {
    // `alignSelf: 'stretch'` para que el header ocupe el ancho del sheet pese al `alignItems:'center'`
    // del cuerpo (Cancelar a la izquierda · título centrado · Confirmar a la derecha).
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: { flex: 1, textAlign: 'center', marginHorizontal: 8 },
  // Alto fijo: en Fabric la rueda necesita una altura explícita para no colapsar a 0.
  // `alignSelf:'center'` + `width:'100%'` centran la rueda dentro del sheet (el cuerpo ya es center).
  picker: { alignSelf: 'center', width: '100%', height: 216 },
});
