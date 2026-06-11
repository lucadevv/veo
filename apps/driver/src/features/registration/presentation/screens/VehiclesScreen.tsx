import React, {useState} from 'react';
import {ActivityIndicator, StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {useQueryClient} from '@tanstack/react-query';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {Banner, Button, Card, SafeScreen, Skeleton, StatusPill, Text, useTheme} from '@veo/ui-kit';
import {TopBar} from '../../../../shared/presentation/components/TopBar';
import {
  vehicleClassGlyph,
  vehicleClassLabelKey,
} from '../../../../shared/presentation/vehicle-class';
import {toErrorMessage} from '../../../../shared/presentation/errors';
import type {RootStackParamList} from '../../../../navigation/types';
import {
  VehicleType,
  VehicleValidationError,
  type VehicleData,
  type VehicleErrors,
  type VehicleView,
} from '../../domain';
import {RegistrationField, VehicleTypeSelector} from '../components';
import {
  ACTIVE_VEHICLE_QUERY_KEY,
  REGISTRATION_VEHICLES_QUERY_KEY,
  useActiveVehicle,
  useDriverVehicles,
  useRegisterVehicle,
  useSetActiveVehicle,
} from '../hooks/useRegistrationWizard';

type Props = NativeStackScreenProps<RootStackParamList, 'Vehicles'>;

const EMPTY_FORM: VehicleData = {type: VehicleType.CAR, plate: '', brand: '', year: '', model: ''};

/** El status `ACTIVE` (vehicle-rules de fleet) = verificado por el operador; el resto, en revisión. */
const VERIFIED_STATUS = 'ACTIVE';

/**
 * "Mis vehículos": gestión post-onboarding de la flota del conductor. Server-authoritative:
 *  - lista los vehículos reales (`GET /drivers/vehicles`) y marca el ACTIVO (`GET /drivers/active-vehicle`),
 *  - cambia el activo por mutación (`PATCH /drivers/active-vehicle`) — el dispatch deriva el tipo de ese,
 *  - permite REGISTRAR un vehículo nuevo (el 2do, p. ej. una moto), que es lo que faltaba para poder
 *    "cambiar de auto a moto" (antes el alta vivía solo en el wizard y bloqueaba el 2do).
 */
export const VehiclesScreen = ({navigation}: Props): React.JSX.Element => {
  const {t} = useTranslation();
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

  const update = (patch: Partial<VehicleData>, field: keyof VehicleErrors) => {
    setForm(prev => ({...prev, ...patch}));
    if (errors[field]) setErrors(prev => ({...prev, [field]: undefined}));
  };

  const fieldError = (field: keyof VehicleErrors): string | undefined => {
    const code = errors[field];
    return code ? t(`registration.vehicle.errors.${code}`) : undefined;
  };

  const canRegister =
    form.plate.trim().length > 0 &&
    form.brand.trim().length > 0 &&
    form.year.trim().length > 0 &&
    form.model.trim().length > 0 &&
    !register.isPending;

  const onRegister = async () => {
    setErrors({});
    setServerError(null);
    try {
      await register.mutateAsync(form);
      queryClient.invalidateQueries({queryKey: REGISTRATION_VEHICLES_QUERY_KEY});
      queryClient.invalidateQueries({queryKey: ACTIVE_VEHICLE_QUERY_KEY});
      setForm(EMPTY_FORM);
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
          <Icon size={22} color={isActive ? theme.colors.accent : theme.colors.inkMuted} strokeWidth={2} />
          <View style={styles.vehicleInfo}>
            <Text variant="subhead" numberOfLines={1}>
              {t(vehicleClassLabelKey(vehicle.vehicleType))} · {vehicle.plate}
            </Text>
            <Text variant="caption" color="inkMuted" numberOfLines={1}>
              {vehicle.make} {vehicle.model} · {vehicle.year}
            </Text>
          </View>
          <StatusPill
            label={isActive ? t('vehicles.active') : verified ? t('vehicles.verified') : t('vehicles.inReview')}
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
            leftIcon={pending ? <ActivityIndicator size="small" color={theme.colors.accent} /> : undefined}
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
            action={{label: t('common.retry'), onPress: () => vehicles.refetch()}}
          />
        ) : list.length === 0 ? (
          <Banner tone="info" title={t('vehicles.empty')} />
        ) : (
          list.map(renderVehicle)
        )}
        {select.isError ? (
          <Banner tone="danger" title={t('shift.vehicleType.changeError')} style={styles.spaced} />
        ) : null}

        {/* ── Agregar un vehículo (el 2do: moto/auto) ── */}
        <Text variant="headline" style={styles.section}>
          {t('vehicles.addTitle')}
        </Text>
        <VehicleTypeSelector value={form.type} onChange={type => setForm(prev => ({...prev, type}))} />
        <View style={styles.form}>
          <RegistrationField
            label={t('registration.vehicle.plateLabel')}
            placeholder={t('registration.vehicle.platePlaceholder')}
            value={form.plate}
            onChangeText={text => update({plate: text.toUpperCase()}, 'plate')}
            autoCapitalize="characters"
            maxLength={8}
            error={fieldError('plate')}
          />
          <View style={styles.row}>
            <View style={styles.flex}>
              <RegistrationField
                label={t('registration.vehicle.brandLabel')}
                placeholder={t('registration.vehicle.brandPlaceholder')}
                value={form.brand}
                onChangeText={text => update({brand: text}, 'brand')}
                autoCapitalize="words"
                error={fieldError('brand')}
              />
            </View>
            <View style={styles.flex}>
              <RegistrationField
                label={t('registration.vehicle.yearLabel')}
                placeholder={t('registration.vehicle.yearPlaceholder')}
                value={form.year}
                onChangeText={text => update({year: text}, 'year')}
                keyboardType="number-pad"
                maxLength={4}
                error={fieldError('year')}
              />
            </View>
          </View>
          <RegistrationField
            label={t('registration.vehicle.modelLabel')}
            placeholder={t('registration.vehicle.modelPlaceholder')}
            value={form.model}
            onChangeText={text => update({model: text}, 'model')}
            autoCapitalize="characters"
            error={fieldError('model')}
          />
          {serverError ? (
            <Banner tone="danger" title={t('errors.generic')} description={toErrorMessage(serverError, t)} />
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
      </View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  body: {padding: 16, gap: 12},
  vehicleCard: {gap: 0},
  vehicleRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  vehicleInfo: {flex: 1},
  section: {marginTop: 12},
  form: {gap: 16, marginTop: 8},
  row: {flexDirection: 'row', gap: 16},
  flex: {flex: 1},
  spaced: {marginTop: 12},
});
