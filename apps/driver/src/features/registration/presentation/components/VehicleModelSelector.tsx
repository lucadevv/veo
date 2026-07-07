import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Banner, Button, Text, TextField, useTheme } from '@veo/ui-kit';
import { IconChevronRight } from '../../../../shared/presentation/icons';
import { useVehicleModels } from '../hooks/useRegistrationWizard';
import { filterVehicleModels } from './vehicle-model-filter';
import { VehicleModelRequestForm } from './VehicleModelRequestForm';
import type { VehicleModelOption, VehicleType } from '../../domain';

interface VehicleModelSelectorProps {
  /** Tipo elegido (filtra el catálogo: un mototaxista solo ve motos). */
  vehicleType: VehicleType;
  /** Modelo elegido (vacío hasta seleccionar): id + etiqueta marca/modelo para mostrar. */
  value: { modelSpecId: string; brand: string; model: string };
  onChange: (model: VehicleModelOption) => void;
  /** Mensaje de error (ya traducido) si no se eligió modelo al validar. */
  error?: string;
}

/**
 * Selector del MODELO del vehículo desde el catálogo curado (B5-2). El conductor toca un campo táctil
 * (look de `RegistrationField`/`DateField`: etiqueta arriba, valor en grande, error debajo) y se abre
 * un bottom sheet con el catálogo (filtrado por tipo) + búsqueda client-side.
 *
 * El sheet es un `Modal` PROPIO (mismo patrón que `DateField`), NO el `BottomSheet` de ui-kit: el cuerpo
 * de ese BottomSheet es un `ScrollView`, y meter una `FlatList` adentro (misma orientación vertical) rompe
 * la virtualización y dispara el warning "VirtualizedLists should never be nested inside plain ScrollViews".
 * Acá la `FlatList` es el ÚNICO scroller del cuerpo (con el buscador como `ListHeaderComponent` sticky), así
 * el catálogo queda virtualizado y escala a un catálogo grande (los operadores agregan modelos).
 *
 * Degrada honesto: carga (spinner), error (banner + reintento), vacío (mensaje) — sin desmontar el buscador.
 */
export function VehicleModelSelector({
  vehicleType,
  value,
  onChange,
  error,
}: VehicleModelSelectorProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Modo del sheet: elegir del catálogo, o solicitar un modelo nuevo que no está (B5-2.c).
  const [mode, setMode] = useState<'pick' | 'request'>('pick');

  const modelsQuery = useVehicleModels(vehicleType);
  // Memoizado: `data ?? []` crearía un array nuevo en cada render (rompiendo el useMemo de `filtered`).
  const models = useMemo(() => modelsQuery.data ?? [], [modelsQuery.data]);

  // Búsqueda client-side (catálogo chico hoy; virtualizado igual): filtra por marca o modelo, case-insensitive.
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

  const title =
    mode === 'request'
      ? t('registration.vehicle.modelRequestTitle')
      : t('registration.vehicle.modelSheetTitle');

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('registration.vehicle.modelSelectLabel')}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
      >
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
          ]}
        >
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
          style={styles.error}
        >
          {error}
        </Text>
      ) : null}

      {/*
        Bottom sheet PROPIO (Modal anclado abajo + backdrop dim), mismo patrón que `DateField`. NO usamos
        el `BottomSheet` de ui-kit porque su cuerpo es un ScrollView que anidaría la FlatList del catálogo.
      */}
      <Modal
        transparent
        visible={open}
        animationType="slide"
        onRequestClose={close}
        statusBarTranslucent
      >
        <View style={styles.modalRoot}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
            style={[styles.backdrop, { backgroundColor: theme.colors.overlay }]}
            onPress={close}
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
                // Acota el alto del sheet bajo el notch; la FlatList scrollea dentro de este tope.
                maxHeight: '85%',
              },
            ]}
          >
            {/* Grabber: barra redondeada centrada arriba (look del BottomSheet de ui-kit). */}
            <View style={styles.handleArea}>
              <View style={[styles.handle, { backgroundColor: theme.colors.borderStrong }]} />
            </View>

            <Text variant="title3" style={[styles.title, { paddingHorizontal: theme.spacing.xl }]}>
              {title}
            </Text>

            {mode === 'request' ? (
              <View style={{ paddingHorizontal: theme.spacing.xl }}>
                <VehicleModelRequestForm
                  vehicleType={vehicleType}
                  onDone={close}
                  onCancel={() => setMode('pick')}
                />
              </View>
            ) : (
              <ModelList
                loading={modelsQuery.isLoading}
                error={modelsQuery.isError}
                models={filtered}
                selectedId={value.modelSpecId}
                onSelect={select}
                onRetry={() => modelsQuery.refetch()}
                search={search}
                onSearch={setSearch}
                onRequest={() => setMode('request')}
              />
            )}
          </View>
        </View>
      </Modal>
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
  /** Texto de búsqueda actual (controlado por el selector). */
  search: string;
  /** Notifica cada tecla del buscador. */
  onSearch: (q: string) => void;
  /** B5-2.c: el conductor no encuentra su modelo → abre el modo "solicitar". */
  onRequest: () => void;
}

/**
 * Catálogo del sheet: una ÚNICA `FlatList` virtualizada, el scroller del cuerpo (NO anidada en ningún
 * ScrollView). El buscador es su `ListHeaderComponent` sticky (scrollea-con-la-lista pero queda fijo
 * arriba) y la salida "no encuentro mi modelo" es el `ListFooterComponent`. Los estados cargando/error/
 * vacío van en `ListEmptyComponent`, manteniendo el buscador siempre visible (la lista nunca se desmonta).
 */
function ModelList({
  loading,
  error,
  models,
  selectedId,
  onSelect,
  onRetry,
  search,
  onSearch,
  onRequest,
}: ModelListProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  const empty = (
    <View style={styles.state}>
      {loading ? (
        <View style={[styles.stateInner, { gap: theme.spacing.md }]}>
          <ActivityIndicator color={theme.colors.accent} />
          <Text variant="footnote" color="inkMuted">
            {t('registration.vehicle.modelLoading')}
          </Text>
        </View>
      ) : error ? (
        <Banner
          tone="danger"
          title={t('errors.generic')}
          description={t('registration.vehicle.modelLoadError')}
          action={{ label: t('common.retry'), onPress: onRetry }}
        />
      ) : (
        <Text variant="callout" color="inkMuted" align="center">
          {t('registration.vehicle.modelEmpty')}
        </Text>
      )}
    </View>
  );

  return (
    <FlatList
      data={models}
      keyExtractor={(m) => m.id}
      keyboardShouldPersistTaps="handled"
      style={styles.list}
      contentContainerStyle={{ paddingHorizontal: theme.spacing.xl, paddingBottom: 8 }}
      stickyHeaderIndices={[0]}
      ListHeaderComponent={
        <View style={[styles.searchArea, { backgroundColor: theme.colors.surface }]}>
          <TextField
            label={t('registration.vehicle.modelSearchLabel')}
            value={search}
            onChangeText={onSearch}
            placeholder={t('registration.vehicle.modelSearchPlaceholder')}
            autoCorrect={false}
          />
        </View>
      }
      ItemSeparatorComponent={() => (
        <View style={[styles.sep, { backgroundColor: theme.colors.border }]} />
      )}
      ListEmptyComponent={empty}
      ListFooterComponent={
        // B5-2.c: salida honesta si el modelo no está en el catálogo.
        <Button
          label={t('registration.vehicle.modelNotFound')}
          variant="ghost"
          onPress={onRequest}
        />
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.make} ${item.model}`}
          accessibilityState={{ selected: item.id === selectedId }}
          onPress={() => onSelect(item)}
          style={[styles.rowItem, { paddingVertical: theme.spacing.md }]}
        >
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
  wrap: { alignSelf: 'stretch', gap: 6 },
  box: { flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'stretch' },
  texts: { flex: 1, gap: 2 },
  error: { paddingHorizontal: 4 },
  // La FlatList es el scroller del sheet; su alto lo acota el `maxHeight` del sheet (no un valor fijo).
  // `flexShrink:1` le deja ceder altura dentro del sheet para poder scrollear.
  list: { flexShrink: 1 },
  // Header sticky: fondo del sheet para que las filas no se vean DEBAJO del buscador al scrollear.
  searchArea: { paddingBottom: 12 },
  state: { paddingVertical: 32, alignItems: 'center', justifyContent: 'center' },
  stateInner: { alignItems: 'center', justifyContent: 'center' },
  sep: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  rowItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowTexts: { flex: 1, gap: 2 },
  // Sheet anclado abajo (mismo patrón que DateField): backdrop dim + cuerpo redondeado arriba.
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill },
  sheet: { width: '100%' },
  handleArea: { alignItems: 'center', paddingVertical: 10 },
  handle: { width: 40, height: 5, borderRadius: 999 },
  title: { paddingBottom: 8 },
});
