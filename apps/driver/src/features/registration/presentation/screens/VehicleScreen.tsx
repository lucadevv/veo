import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import { VehicleValidationError, type VehicleErrors } from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';
import {
  REGISTRATION_VEHICLES_QUERY_KEY,
  useDriverVehicles,
  useRegisterVehicle,
} from '../hooks/useRegistrationWizard';
import {
  RegistrationField,
  RegistrationHeader,
  RegistrationProgress,
  VehicleModelSelector,
  VehicleStatusCard,
  VehicleTypeSelector,
} from '../components';
import type { VehicleModelOption } from '../../domain';

type Props = NativeStackScreenProps<RegistrationStackParamList, 'Vehicle'>;

/** Paso 2 del alta: tipo de vehículo y datos del mismo (drv-05). POST/GET /drivers/vehicles. */
export const VehicleScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const vehicle = useRegistrationStore((s) => s.vehicle);
  const setVehicle = useRegistrationStore((s) => s.setVehicle);
  const setVehicleType = useRegistrationStore((s) => s.setVehicleType);
  const setCurrentStep = useRegistrationStore((s) => s.setCurrentStep);

  // Rehidrata el vehículo ya registrado (si existe) para mostrar su estado y bloquear el re-alta.
  const vehiclesQuery = useDriverVehicles();
  const registerVehicle = useRegisterVehicle();
  const existingVehicle = vehiclesQuery.data?.[0] ?? null;

  const [errors, setErrors] = useState<VehicleErrors>({});
  const [serverError, setServerError] = useState<unknown>(null);

  const canContinue =
    vehicle.plate.trim().length > 0 &&
    vehicle.year.trim().length > 0 &&
    vehicle.modelSpecId.trim().length > 0;

  /** Actualiza un campo del vehículo y limpia su error inline. */
  const update = (patch: Partial<typeof vehicle>, field: keyof VehicleErrors) => {
    setVehicle(patch);
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  /** El conductor eligió un modelo del catálogo: guarda id + etiqueta y limpia el error de modelo. */
  const onPickModel = (model: VehicleModelOption) => {
    setVehicle({ modelSpecId: model.id, brand: model.make, model: model.model });
    if (errors.model) {
      setErrors((prev) => ({ ...prev, model: undefined }));
    }
  };

  /**
   * Cambiar el tipo de vehículo invalida el modelo elegido (el catálogo se filtra por tipo: un modelo
   * de auto no aplica a una moto). Limpia la elección para forzar re-seleccionar del catálogo correcto.
   */
  const onChangeType = (type: typeof vehicle.type) => {
    setVehicleType(type);
    setVehicle({ modelSpecId: '', brand: '', model: '' });
  };

  const goNext = () => {
    setCurrentStep(3);
    navigation.navigate('Documents');
  };

  const onContinue = async () => {
    // Si ya hay un vehículo registrado (en revisión), solo avanzamos: no se vuelve a registrar.
    if (existingVehicle) {
      goNext();
      return;
    }
    if (registerVehicle.isPending) {
      return;
    }
    setErrors({});
    setServerError(null);
    try {
      await registerVehicle.mutateAsync(vehicle);
      queryClient.invalidateQueries({ queryKey: REGISTRATION_VEHICLES_QUERY_KEY });
      goNext();
    } catch (e) {
      if (e instanceof VehicleValidationError) {
        setErrors(e.errors);
      } else {
        setServerError(e);
      }
    }
  };

  /** Traduce un código de error de campo a su mensaje. */
  const fieldError = (field: keyof VehicleErrors): string | undefined => {
    const code = errors[field];
    return code ? t(`registration.vehicle.errors.${code}`) : undefined;
  };

  return (
    <SafeScreen
      scroll
      header={<RegistrationHeader showLogo={false} onBack={navigation.goBack} />}
      footer={
        <Button
          label={existingVehicle ? t('common.continue') : t('registration.vehicle.register')}
          variant="accent"
          fullWidth
          loading={registerVehicle.isPending}
          disabled={!existingVehicle && !canContinue}
          onPress={onContinue}
        />
      }
    >
      <View style={[styles.body, { gap: theme.spacing.xl }]}>
        <Reveal>
          <RegistrationProgress current={2} />
        </Reveal>

        <Reveal delay={40} style={styles.intro}>
          <Text variant="caption" color="inkMuted" align="center">
            {t('registration.stepOf', { current: 2, total: 4 })}
          </Text>
          <Text variant="title1" align="center">
            {t('registration.vehicle.title')}
          </Text>
          <Text variant="callout" color="inkMuted" align="center">
            {existingVehicle
              ? t('registration.vehicle.registeredSubtitle')
              : t('registration.vehicle.subtitle')}
          </Text>
        </Reveal>

        {serverError ? (
          <Reveal>
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(serverError, t)}
            />
          </Reveal>
        ) : null}

        {existingVehicle ? (
          <Reveal delay={100} spring>
            <VehicleStatusCard vehicle={existingVehicle} />
          </Reveal>
        ) : (
          <>
            <Reveal delay={100}>
              <VehicleTypeSelector value={vehicle.type} onChange={onChangeType} />
            </Reveal>

            <View style={[styles.form, { gap: theme.spacing.lg }]}>
              {/* B5-2: el modelo se ELIGE del catálogo curado (no texto libre), filtrado por tipo. */}
              <Reveal delay={150} from="scale">
                <VehicleModelSelector
                  vehicleType={vehicle.type}
                  value={{
                    modelSpecId: vehicle.modelSpecId,
                    brand: vehicle.brand,
                    model: vehicle.model,
                  }}
                  onChange={onPickModel}
                  error={fieldError('model')}
                />
              </Reveal>

              <Reveal delay={190} from="scale">
                <RegistrationField
                  label={t('registration.vehicle.plateLabel')}
                  placeholder={t('registration.vehicle.platePlaceholder')}
                  value={vehicle.plate}
                  onChangeText={(text) => update({ plate: text.toUpperCase() }, 'plate')}
                  autoCapitalize="characters"
                  maxLength={8}
                  error={fieldError('plate')}
                />
              </Reveal>

              <Reveal delay={220} from="scale">
                <RegistrationField
                  label={t('registration.vehicle.yearLabel')}
                  placeholder={t('registration.vehicle.yearPlaceholder')}
                  value={vehicle.year}
                  onChangeText={(text) => update({ year: text }, 'year')}
                  keyboardType="number-pad"
                  maxLength={4}
                  error={fieldError('year')}
                />
              </Reveal>
            </View>
          </>
        )}
      </View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  body: { paddingTop: 12 },
  intro: { gap: 6 },
  form: {},
});
