import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  Banner,
  BottomSheet,
  Button,
  Card,
  SafeScreen,
  Skeleton,
  StatusPill,
  Text,
  useTheme,
} from '@veo/ui-kit';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { IconPlus } from '../../../../shared/presentation/icons';
import {
  vehicleClassGlyph,
  vehicleClassLabelKey,
} from '../../../../shared/presentation/vehicle-class';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import type { RootStackParamList } from '../../../../navigation/types';
import {
  VehicleType,
  VehicleValidationError,
  type VehicleData,
  type VehicleErrors,
  type VehicleModelOption,
  type VehicleView,
} from '../../domain';
import { RegistrationField, VehicleModelSelector, VehicleTypeSelector } from '../components';
import {
  ACTIVE_VEHICLE_QUERY_KEY,
  REGISTRATION_VEHICLES_QUERY_KEY,
  useActiveVehicle,
  useDriverVehicles,
  useRegisterVehicle,
  useSetActiveVehicle,
} from '../hooks/useRegistrationWizard';

type Props = NativeStackScreenProps<RootStackParamList, 'Vehicles'>;

// "Mis vehículos" (gestión post-onboarding, NO el wizard): alta de un 2do vehículo por SELECCIÓN MANUAL del
// catálogo (sin OCR de tarjeta). El catálogo se filtra por tipo, así que el form arranca con un tipo elegible
// (CAR) que el conductor cambia con el selector (ambos tipos visibles). No es el "seed silencioso" del alta
// scan-first (ahí el tipo lo DERIVA la tarjeta o arranca null); acá el tipo es una elección activa del form.
const EMPTY_FORM: VehicleData = {
  type: VehicleType.CAR,
  plate: '',
  year: '',
  modelSpecId: '',
  brand: '',
  model: '',
  mtcCategory: '',
  // "Mis vehículos" es alta manual por catálogo (sin OCR de tarjeta): el color queda vacío y se omite del body.
  color: '',
};

/** El status `ACTIVE` (vehicle-rules de fleet) = verificado por el operador; el resto, en revisión. */
const VERIFIED_STATUS = 'ACTIVE';

/**
 * "Mis vehículos": gestión post-onboarding de la flota del conductor. Server-authoritative:
 *  - lista los vehículos reales (`GET /drivers/vehicles`) y marca el ACTIVO (`GET /drivers/active-vehicle`),
 *  - cambia el activo por mutación (`PATCH /drivers/active-vehicle`) — el dispatch deriva el tipo de ese,
 *  - permite REGISTRAR un vehículo nuevo (el 2do, p. ej. una moto), que es lo que faltaba para poder
 *    "cambiar de auto a moto" (antes el alta vivía solo en el wizard y bloqueaba el 2do).
 */
export const VehiclesScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();

  const vehicles = useDriverVehicles();
  const active = useActiveVehicle();
  const select = useSetActiveVehicle();
  const register = useRegisterVehicle();

  const list = vehicles.data ?? [];
  const activeId = active.data?.id;

  const [form, setForm] = useState<VehicleData>(EMPTY_FORM);
  const [errors, setErrors] = useState<VehicleErrors>({});
  const [serverError, setServerError] = useState<unknown>(null);
  // El alta vive en un sheet (fiel al frame C/Vehiculos: la pantalla es la LISTA + un botón "Agregar").
  const [addOpen, setAddOpen] = useState(false);

  const closeAdd = () => {
    setAddOpen(false);
    setForm(EMPTY_FORM);
    setErrors({});
    setServerError(null);
  };

  const update = (patch: Partial<VehicleData>, field: keyof VehicleErrors) => {
    setForm((prev) => ({ ...prev, ...patch }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  /** Cambiar el tipo invalida el modelo elegido (el catálogo se filtra por tipo). */
  const onChangeType = (type: VehicleType) => {
    setForm((prev) => ({ ...prev, type, modelSpecId: '', brand: '', model: '' }));
  };

  /** El conductor eligió un modelo del catálogo: guarda id + etiqueta y limpia el error de modelo. */
  const onPickModel = (model: VehicleModelOption) => {
    setForm((prev) => ({ ...prev, modelSpecId: model.id, brand: model.make, model: model.model }));
    if (errors.model) setErrors((prev) => ({ ...prev, model: undefined }));
  };

  const fieldError = (field: keyof VehicleErrors): string | undefined => {
    const code = errors[field];
    return code ? t(`registration.vehicle.errors.${code}`) : undefined;
  };

  const canRegister =
    form.plate.trim().length > 0 &&
    form.year.trim().length > 0 &&
    form.modelSpecId.trim().length > 0 &&
    !register.isPending;

  const onRegister = async () => {
    setErrors({});
    setServerError(null);
    try {
      await register.mutateAsync(form);
      queryClient.invalidateQueries({ queryKey: REGISTRATION_VEHICLES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ACTIVE_VEHICLE_QUERY_KEY });
      closeAdd();
    } catch (e) {
      if (e instanceof VehicleValidationError) setErrors(e.errors);
      else setServerError(e);
    }
  };

  const renderVehicle = (vehicle: VehicleView) => {
    const isActive = vehicle.id === activeId;
    const Icon = vehicleClassGlyph(vehicle.vehicleType);
    const pending = select.isPending && select.variables === vehicle.id;
    const verified = vehicle.status === VERIFIED_STATUS;
    return (
      <Card key={vehicle.id} variant={isActive ? 'filled' : 'outlined'} style={styles.vehicleCard}>
        <View style={styles.vehicleRow}>
          <Icon
            size={22}
            color={isActive ? theme.colors.accent : theme.colors.inkMuted}
            strokeWidth={2}
          />
          <View style={styles.vehicleInfo}>
            <Text variant="subhead" numberOfLines={1}>
              {t(vehicleClassLabelKey(vehicle.vehicleType))} · {vehicle.plate}
            </Text>
            <Text variant="caption" color="inkMuted" numberOfLines={1}>
              {vehicle.make} {vehicle.model} · {vehicle.year}
            </Text>
          </View>
          <StatusPill
            label={
              isActive
                ? t('vehicles.active')
                : verified
                  ? t('vehicles.verified')
                  : t('vehicles.inReview')
            }
            tone={isActive ? 'accent' : verified ? 'success' : 'warn'}
            dot
          />
        </View>
        {!isActive ? (
          <Button
            label={pending ? '' : t('vehicles.setActive')}
            variant="secondary"
            size="sm"
            fullWidth
            disabled={pending}
            leftIcon={
              pending ? <ActivityIndicator size="small" color={theme.colors.accent} /> : undefined
            }
            onPress={() => select.mutate(vehicle.id)}
            style={styles.spaced}
          />
        ) : null}
      </Card>
    );
  };

  return (
    <SafeScreen scroll header={<TopBar title={t('vehicles.title')} onBack={navigation.goBack} />}>
      <View style={styles.body}>
        {/* ── Mis vehículos (lista + activo) ── */}
        {vehicles.isLoading || active.isLoading ? (
          <Skeleton height={96} radius={theme.radii.lg} />
        ) : vehicles.isError ? (
          <Banner
            tone="danger"
            title={t('errors.generic')}
            description={toErrorMessage(vehicles.error, t)}
            action={{ label: t('common.retry'), onPress: () => vehicles.refetch() }}
          />
        ) : list.length === 0 ? (
          <Banner tone="info" title={t('vehicles.empty')} />
        ) : (
          list.map(renderVehicle)
        )}
        {select.isError ? (
          <Banner tone="danger" title={t('shift.vehicleType.changeError')} style={styles.spaced} />
        ) : null}

        {/* ── Agregar vehículo: abre el sheet de alta. La pantalla es la LISTA + esta acción (frame). ── */}
        <Button
          label={t('vehicles.addAction')}
          variant="secondary"
          fullWidth
          leftIcon={<IconPlus size={20} color={theme.colors.accent} />}
          onPress={() => setAddOpen(true)}
          style={styles.section}
        />
      </View>

      <BottomSheet visible={addOpen} onClose={closeAdd} title={t('vehicles.addTitle')}>
        <View style={styles.form}>
          <VehicleTypeSelector value={form.type} onChange={onChangeType} />
          {/* B5-2: el modelo se ELIGE del catálogo curado (filtrado por tipo), no a texto libre. En este
              flujo el tipo del form SIEMPRE está definido (arranca CAR, el selector ofrece ambos); el `??`
              es defensa de tipos por el `VehicleType | null` de VehicleData, no un seed silencioso. */}
          <VehicleModelSelector
            vehicleType={form.type ?? VehicleType.CAR}
            value={{ modelSpecId: form.modelSpecId, brand: form.brand, model: form.model }}
            onChange={onPickModel}
            error={fieldError('model')}
          />
          <RegistrationField
            label={t('registration.vehicle.plateLabel')}
            placeholder={t('registration.vehicle.platePlaceholder')}
            value={form.plate}
            onChangeText={(text) => update({ plate: text.toUpperCase() }, 'plate')}
            autoCapitalize="characters"
            maxLength={8}
            error={fieldError('plate')}
          />
          <RegistrationField
            label={t('registration.vehicle.yearLabel')}
            placeholder={t('registration.vehicle.yearPlaceholder')}
            value={form.year}
            onChangeText={(text) => update({ year: text }, 'year')}
            keyboardType="number-pad"
            maxLength={4}
            error={fieldError('year')}
          />
          {serverError ? (
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(serverError, t)}
            />
          ) : null}
          <Button
            label={t('registration.vehicle.register')}
            variant="accent"
            fullWidth
            loading={register.isPending}
            disabled={!canRegister}
            onPress={onRegister}
          />
        </View>
      </BottomSheet>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  body: { padding: 16, gap: 12 },
  vehicleCard: { gap: 0 },
  vehicleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  vehicleInfo: { flex: 1 },
  section: { marginTop: 12 },
  form: { gap: 16, marginTop: 8 },
  spaced: { marginTop: 12 },
});
