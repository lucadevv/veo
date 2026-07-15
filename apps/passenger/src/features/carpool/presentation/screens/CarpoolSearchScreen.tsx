import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {Button, Card, SafeScreen, Text, useTheme} from '@veo/ui-kit';
import React, {useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, ScrollView, StyleSheet, View} from 'react-native';
import type {
  CarpoolSearchQuery,
  RootStackParamList,
} from '../../../../navigation/types';
import {ScreenHeader} from '../../../../shared/presentation/components/ScreenHeader';
import {SelectableChip} from '../../../../shared/presentation/components/SelectableChip';
import {
  CARPOOL_MAX_SEATS,
  CARPOOL_MIN_SEATS,
  type CarpoolDayOption,
  carpoolDayOptions,
} from '../../domain/entities';
import {
  IconMinus,
  IconPin,
  IconPlus,
  IconTarget,
} from '../../../trip/presentation/components/icons';
import {formatIsoDayShort} from '../../../../shared/utils/formatDay';
import {
  type CarpoolPlacePick,
  CarpoolPlacePickerSheet,
} from '../components/CarpoolPlacePickerSheet';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** Etiquetas cortas de día de semana es-PE (0=domingo), para los chips de fecha. */
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
 * Buscador de carpooling por RUTA (design/veo.pen P/ProgSearch), pushado desde la pill del FEED del
 * tab Compartir (el feed es la raíz browse-first; buscar es intención concreta). Origen/Destino con
 * el autocompletado real (picker propio, SIN tocar el rideDraftStore del flujo on-demand), FECHA
 * como día calendario (chips, sin hora: se busca por día) y stepper de ASIENTOS (1..8). El CTA
 * navega a los resultados con la query completa en params. La sección "Rutas populares" del pen se
 * omite ACÁ a propósito — pero ya NO por falta de backend: el endpoint existe
 * (GET /carpool/trips/popular-routes) y su casa es el FEED del tab Compartir (la raíz browse-first
 * que precede a esta pantalla), donde la sección vive y filtra al tap. Repetirla en el buscador
 * sería redundante: quien llega acá ya pasó por ella y viene con intención de ruta concreta.
 */
export function CarpoolSearchScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();

  const [origin, setOrigin] = useState<CarpoolPlacePick | null>(null);
  const [destination, setDestination] = useState<CarpoolPlacePick | null>(null);
  const [picker, setPicker] = useState<'origin' | 'destination' | null>(null);

  // Días desde HOY (estables durante la vida de la pantalla; una búsqueda dura segundos).
  const days = useMemo(() => carpoolDayOptions(new Date()), []);
  const [fecha, setFecha] = useState<string>(days[0]?.iso ?? '');
  const [asientos, setAsientos] = useState(CARPOOL_MIN_SEATS);

  const dayLabel = (day: CarpoolDayOption, index: number): string => {
    if (index === 0) {
      return t('schedule.today');
    }
    if (index === 1) {
      return t('schedule.tomorrow');
    }
    return `${WEEKDAY_LABELS[day.weekday]} ${day.dayOfMonth}`;
  };

  const canSearch = origin !== null && destination !== null && fecha !== '';

  const search = (): void => {
    if (!origin || !destination) {
      return;
    }
    const query: CarpoolSearchQuery = {
      originLat: origin.lat,
      originLon: origin.lon,
      originLabel: origin.label,
      destLat: destination.lat,
      destLon: destination.lon,
      destLabel: destination.label,
      fecha,
      asientos,
    };
    navigation.navigate('CarpoolResults', {search: query});
  };

  return (
    <SafeScreen
      padded={false}
      footer={
        <Button
          label={t('carpool.searchCta')}
          fullWidth
          disabled={!canSearch}
          onPress={search}
        />
      }>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
        showsVerticalScrollIndicator={false}>
        {/* Header in-body (patrón ScreenHeader del pen): back pill + título display. */}
        <ScreenHeader
          title={t('screens.carpoolSearch')}
          subtitle={t('carpool.searchSubtitle')}
        />

        {/* Card de ruta: Desde / Hasta (pen SearchCard). Cada fila abre el picker con autocompletado. */}
        <Card variant="outlined" padding="md">
          <View style={{gap: theme.spacing.md}}>
            <EndpointRow
              icon={<IconTarget color={theme.colors.accent} size={16} />}
              label={t('carpool.fromLabel')}
              value={origin?.label ?? null}
              placeholder={t('carpool.fromPlaceholder')}
              onPress={() => setPicker('origin')}
            />
            <View
              style={[styles.divider, {backgroundColor: theme.colors.border}]}
            />
            <EndpointRow
              icon={<IconPin color={theme.colors.inkMuted} size={16} />}
              label={t('carpool.toLabel')}
              value={destination?.label ?? null}
              placeholder={t('carpool.toPlaceholder')}
              onPress={() => setPicker('destination')}
            />
          </View>
        </Card>

        {/* Fecha: chips de día calendario (patrón de ScheduleSheet, sin hora). */}
        <View style={{gap: theme.spacing.sm}}>
          <View style={styles.dateHeader}>
            <Text variant="subhead" color="inkMuted">
              {t('carpool.dateLabel')}
            </Text>
            {/* La fecha elegida, legible ("Vie 4 jul", pen chip Fecha). */}
            <Text variant="footnote" color="inkSubtle">
              {formatIsoDayShort(fecha)}
            </Text>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{gap: theme.spacing.sm}}>
            {days.map((day, index) => (
              <SelectableChip
                key={day.iso}
                label={dayLabel(day, index)}
                selected={day.iso === fecha}
                onPress={() => setFecha(day.iso)}
              />
            ))}
          </ScrollView>
        </View>

        {/* Asientos: stepper 1..8 (límites del contrato del wire). */}
        <View style={{gap: theme.spacing.sm}}>
          <Text variant="subhead" color="inkMuted">
            {t('carpool.seatsLabel')}
          </Text>
          <View style={[styles.stepperRow, {gap: theme.spacing.md}]}>
            <StepperButton
              icon={<IconMinus color={theme.colors.ink} size={20} />}
              disabled={asientos <= CARPOOL_MIN_SEATS}
              accessibilityLabel={t('actions.delete')}
              onPress={() => setAsientos(current => current - 1)}
            />
            <Text variant="headline" tabular>
              {asientos === 1
                ? t('carpool.seatsOne')
                : t('carpool.seatsMany', {count: asientos})}
            </Text>
            <StepperButton
              icon={<IconPlus color={theme.colors.ink} size={20} />}
              disabled={asientos >= CARPOOL_MAX_SEATS}
              accessibilityLabel={t('actions.add')}
              onPress={() => setAsientos(current => current + 1)}
            />
          </View>
        </View>
      </ScrollView>

      <CarpoolPlacePickerSheet
        visible={picker !== null}
        kind={picker ?? 'origin'}
        onClose={() => setPicker(null)}
        onSelect={pick => {
          if (picker === 'origin') {
            setOrigin(pick);
          } else {
            setDestination(pick);
          }
        }}
      />
    </SafeScreen>
  );
}

interface EndpointRowProps {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  placeholder: string;
  onPress: () => void;
}

/** Fila Desde/Hasta del card de búsqueda: ícono en burbuja + label chico + valor (o placeholder). */
function EndpointRow({
  icon,
  label,
  value,
  placeholder,
  onPress,
}: EndpointRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value ?? placeholder}`}
      onPress={onPress}
      style={({pressed}) => [
        styles.endpointRow,
        {gap: theme.spacing.md, opacity: pressed ? 0.7 : 1},
      ]}>
      <View
        style={[
          styles.iconBubble,
          {backgroundColor: theme.colors.surfaceElevated},
        ]}>
        {icon}
      </View>
      <View style={styles.flex}>
        <Text variant="caption" color="inkSubtle">
          {label}
        </Text>
        <Text
          variant="bodyStrong"
          color={value ? 'ink' : 'inkSubtle'}
          numberOfLines={1}>
          {value ?? placeholder}
        </Text>
      </View>
    </Pressable>
  );
}

interface StepperButtonProps {
  icon: React.ReactNode;
  disabled: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}

/** Botón circular −/+ del stepper de asientos (hit-target 44pt). */
function StepperButton({
  icon,
  disabled,
  accessibilityLabel,
  onPress,
}: StepperButtonProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{disabled}}
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.stepperButton,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor: theme.colors.border,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
      ]}>
      {icon}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  divider: {height: StyleSheet.hairlineWidth, alignSelf: 'stretch'},
  dateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  endpointRow: {flexDirection: 'row', alignItems: 'center'},
  iconBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flex: {flex: 1},
  stepperRow: {flexDirection: 'row', alignItems: 'center'},
  stepperButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
