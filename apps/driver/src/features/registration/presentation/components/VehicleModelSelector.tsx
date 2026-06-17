import React, {useMemo, useState} from 'react';
import {ActivityIndicator, FlatList, Pressable, StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {Banner, BottomSheet, Button, Text, TextField, useTheme} from '@veo/ui-kit';
import {IconChevronRight} from '../../../../shared/presentation/icons';
import {useVehicleModels} from '../hooks/useRegistrationWizard';
import {filterVehicleModels} from './vehicle-model-filter';
import {VehicleModelRequestForm} from './VehicleModelRequestForm';
import type {VehicleModelOption, VehicleType} from '../../domain';

interface VehicleModelSelectorProps {
  /** Tipo elegido (filtra el catálogo: un mototaxista solo ve motos). */
  vehicleType: VehicleType;
  /** Modelo elegido (vacío hasta seleccionar): id + etiqueta marca/modelo para mostrar. */
  value: {modelSpecId: string; brand: string; model: string};
  onChange: (model: VehicleModelOption) => void;
  /** Mensaje de error (ya traducido) si no se eligió modelo al validar. */
  error?: string;
}

/**
 * Selector del MODELO del vehículo desde el catálogo curado (B5-2). Reemplaza los campos de marca/modelo
 * a texto libre: el conductor toca el campo, se abre un bottom sheet con el catálogo (filtrado por tipo)
 * y una búsqueda client-side (el catálogo es chico). Al elegir, se cierra y el campo muestra la elección.
 * Degrada honesto: carga (spinner), error (banner + reintento implícito al reabrir), vacío (mensaje).
 */
export function VehicleModelSelector({
  vehicleType,
  value,
  onChange,
  error,
}: VehicleModelSelectorProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Modo del sheet: elegir del catálogo, o solicitar un modelo nuevo que no está (B5-2.c).
  const [mode, setMode] = useState<'pick' | 'request'>('pick');

  const modelsQuery = useVehicleModels(vehicleType);
  const models = modelsQuery.data ?? [];

  // Búsqueda client-side (catálogo chico): filtra por marca o modelo, case-insensitive.
  const filtered = useMemo(() => filterVehicleModels(models, search), [models, search]);

  const selectedLabel = value.modelSpecId
    ? `${value.brand} ${value.model}`.trim()
    : t('registration.vehicle.modelSelectPlaceholder');

  const borderColor = error ? theme.colors.danger : theme.colors.border;

  const select = (model: VehicleModelOption) => {
    onChange(model);
    close();
  };

  /** Cierra el sheet y resetea búsqueda + modo (al reabrir parte de la lista completa). */
  const close = () => {
    setOpen(false);
    setSearch('');
    setMode('pick');
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('registration.vehicle.modelSelectLabel')}
        accessibilityState={{expanded: open}}
        onPress={() => setOpen(true)}>
        <View
          style={[
            styles.box,
            {
              backgroundColor: theme.colors.surface,
              borderColor,
              borderWidth: error ? 2 : 1,
              borderRadius: theme.radii.md,
              paddingHorizontal: theme.spacing.lg,
              paddingVertical: theme.spacing.md,
            },
          ]}>
          <View style={styles.texts}>
            <Text variant="footnote" color="inkMuted">
              {t('registration.vehicle.modelSelectLabel')}
            </Text>
            <Text variant="body" color={value.modelSpecId ? 'ink' : 'inkSubtle'}>
              {selectedLabel}
            </Text>
          </View>
          <IconChevronRight size={20} color={theme.colors.inkMuted} />
        </View>
      </Pressable>

      {error ? (
        <Text
          variant="footnote"
          color="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.error}>
          {error}
        </Text>
      ) : null}

      <BottomSheet
        visible={open}
        onClose={close}
        title={
          mode === 'request'
            ? t('registration.vehicle.modelRequestTitle')
            : t('registration.vehicle.modelSheetTitle')
        }>
        {mode === 'request' ? (
          <VehicleModelRequestForm
            vehicleType={vehicleType}
            onDone={close}
            onCancel={() => setMode('pick')}
          />
        ) : (
          <View style={[styles.sheet, {gap: theme.spacing.md}]}>
            <TextField
              label={t('registration.vehicle.modelSearchLabel')}
              value={search}
              onChangeText={setSearch}
              placeholder={t('registration.vehicle.modelSearchPlaceholder')}
              autoCorrect={false}
            />
            <ModelList
              loading={modelsQuery.isLoading}
              error={modelsQuery.isError}
              models={filtered}
              selectedId={value.modelSpecId}
              onSelect={select}
              onRetry={() => modelsQuery.refetch()}
            />
            {/* B5-2.c: salida honesta si el modelo no está en el catálogo. */}
            <Button
              label={t('registration.vehicle.modelNotFound')}
              variant="ghost"
              onPress={() => setMode('request')}
            />
          </View>
        )}
      </BottomSheet>
    </View>
  );
}

interface ModelListProps {
  loading: boolean;
  error: boolean;
  models: VehicleModelOption[];
  selectedId: string;
  onSelect: (m: VehicleModelOption) => void;
  onRetry: () => void;
}

/** Lista del catálogo con sus 4 estados: cargando, error (con reintento), vacío y datos. */
function ModelList({loading, error, models, selectedId, onSelect, onRetry}: ModelListProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  if (loading) {
    return (
      <View style={[styles.state, {gap: theme.spacing.md}]}>
        <ActivityIndicator color={theme.colors.accent} />
        <Text variant="footnote" color="inkMuted">
          {t('registration.vehicle.modelLoading')}
        </Text>
      </View>
    );
  }
  if (error) {
    return (
      <Banner
        tone="danger"
        title={t('errors.generic')}
        description={t('registration.vehicle.modelLoadError')}
        action={{label: t('common.retry'), onPress: onRetry}}
      />
    );
  }
  if (models.length === 0) {
    return (
      <View style={styles.state}>
        <Text variant="callout" color="inkMuted" align="center">
          {t('registration.vehicle.modelEmpty')}
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={models}
      keyExtractor={m => m.id}
      keyboardShouldPersistTaps="handled"
      style={styles.list}
      ItemSeparatorComponent={() => (
        <View style={[styles.sep, {backgroundColor: theme.colors.border}]} />
      )}
      renderItem={({item}) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.make} ${item.model}`}
          accessibilityState={{selected: item.id === selectedId}}
          onPress={() => onSelect(item)}
          style={[styles.rowItem, {paddingVertical: theme.spacing.md}]}>
          <View style={styles.rowTexts}>
            <Text variant="bodyStrong" color="ink">
              {item.make} {item.model}
            </Text>
            <Text variant="footnote" color="inkMuted">
              {t('registration.vehicle.modelMeta', {
                yearFrom: item.yearFrom,
                yearTo: item.yearTo,
                seats: item.seats,
              })}
            </Text>
          </View>
          {item.id === selectedId ? (
            <Text variant="footnote" color="accent">
              {t('registration.vehicle.modelSelected')}
            </Text>
          ) : null}
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  wrap: {alignSelf: 'stretch', gap: 6},
  box: {flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'stretch'},
  texts: {flex: 1, gap: 2},
  error: {paddingHorizontal: 4},
  sheet: {paddingBottom: 8},
  list: {maxHeight: 360},
  state: {paddingVertical: 32, alignItems: 'center', justifyContent: 'center'},
  sep: {height: StyleSheet.hairlineWidth, alignSelf: 'stretch'},
  rowItem: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12},
  rowTexts: {flex: 1, gap: 2},
});
