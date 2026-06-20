import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { isConflictError, toErrorMessage } from '../../../../shared/presentation/errors';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import { VehicleValidationError, type VehicleErrors } from '../../domain';
import { useRegistrationStore } from '../state/registrationStore';
import { useRegistrationStepBack } from '../hooks/useRegistrationStepBack';
import {
  REGISTRATION_VEHICLES_QUERY_KEY,
  useDriverVehicles,
  useRegisterVehicle,
} from '../hooks/useRegistrationWizard';
import {
  useRegistrationDocuments,
  useUploadAndRegisterDocument,
} from '../hooks/useRegistrationDocuments';
import { useDocumentScanner, useImagePicker } from '../../../../core/di/useDi';
import {
  DocumentUploadCard,
  RegistrationDocumentSheet,
  RegistrationExitSheet,
  RegistrationField,
  RegistrationHeader,
  RegistrationProgress,
  VehicleModelSelector,
  VehicleStatusCard,
  VehicleTypeSelector,
} from '../components';
import type {
  DocumentUploadState,
  RegistrationDocumentInput,
} from '../components/RegistrationDocumentSheet';
import { IconCar } from '../../../../shared/presentation/icons';
import { registrationDocTypeToBackend, type VehicleModelOption } from '../../domain';

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

  // Back robusto del paso: reconstruye la pila al reanudar (si quedó superficial) y nunca dispara un
  // GO_BACK muerto (si no hay paso previo, abre el exit-confirm del Lote 1). Cubre software + hardware.
  const back = useRegistrationStepBack();

  // Rehidrata el vehículo ya registrado (si existe) para mostrar su estado y bloquear el re-alta.
  const vehiclesQuery = useDriverVehicles();
  const registerVehicle = useRegisterVehicle();
  const existingVehicle = vehiclesQuery.data?.[0] ?? null;

  const [errors, setErrors] = useState<VehicleErrors>({});
  const [serverError, setServerError] = useState<unknown>(null);

  // Foto del vehículo (Ola 1): se captura ACÁ (paso 2) reusando el pipeline de documentos. Se registra
  // como doc DRIVER-scoped (VEHICLE_PHOTO) y es REQUERIDA para aprobar (gate server-side en admin-bff).
  const documents = useRegistrationStore((s) => s.documents);
  const setDocumentStatus = useRegistrationStore((s) => s.setDocumentStatus);
  const serverDocs = useRegistrationDocuments();
  const uploadDocument = useUploadAndRegisterDocument();
  const imagePicker = useImagePicker();
  const documentScanner = useDocumentScanner();
  const photoBackendType = registrationDocTypeToBackend('VEHICLE_PHOTO');

  const [photoSheetOpen, setPhotoSheetOpen] = useState(false);
  const [photoUploadState, setPhotoUploadState] = useState<DocumentUploadState>('idle');
  const [photoError, setPhotoError] = useState<unknown>(null);

  // Subida confirmada: local (recién capturada) o ya presente en el servidor (conductor que vuelve).
  const photoUploaded =
    documents.find((d) => d.type === 'VEHICLE_PHOTO')?.status === 'uploaded' ||
    (serverDocs.data?.some((d) => d.type === photoBackendType) ?? false);

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

  /** Sube+registra la foto del vehículo (reusa el pipeline de documentos; sin número ni vencimiento). */
  const onSubmitPhoto = async (input: RegistrationDocumentInput) => {
    setPhotoError(null);
    setPhotoUploadState('uploading');
    try {
      await uploadDocument.mutateAsync({ type: photoBackendType, file: input.file });
      setDocumentStatus('VEHICLE_PHOTO', 'uploaded');
      setPhotoUploadState('success');
      // Cierra el sheet tras el check de éxito (igual que el paso de documentos).
      setTimeout(() => {
        setPhotoSheetOpen(false);
        setPhotoUploadState('idle');
      }, 900);
    } catch (e) {
      setPhotoError(e);
      setPhotoUploadState('error');
    }
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
      } else if (isConflictError(e)) {
        // 409 del alta = la placa pertenece a OTRO conductor (la propia es idempotente server-side).
        // Lo mostramos como error INLINE del campo placa (accionable), no como banner genérico.
        setErrors({ plate: 'plate_taken' });
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
    <>
    <SafeScreen
      scroll
      header={<RegistrationHeader showLogo={false} onBack={back.onBack} />}
      footer={
        <Button
          label={existingVehicle ? t('common.continue') : t('registration.vehicle.register')}
          variant="accent"
          fullWidth
          loading={registerVehicle.isPending}
          // La foto del vehículo es REQUERIDA para avanzar (en alta nueva Y con vehículo ya registrado).
          disabled={(!existingVehicle && !canContinue) || !photoUploaded}
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

        {/* Foto del vehículo (Ola 1): se captura ACÁ (junto a los datos del auto), es REQUERIDA para
            aprobar. Reusa el sheet de captura + el pipeline de subida de documentos (foto sin número). */}
        <Reveal delay={250}>
          <DocumentUploadCard
            icon={<IconCar size={26} color={theme.colors.accent} strokeWidth={1.8} />}
            label={t('registration.vehicle.photoLabel')}
            status={photoUploaded ? 'uploaded' : 'pending'}
            uploadedLabel={t('registration.documents.uploaded')}
            pendingLabel={t('registration.documents.pending')}
            busy={uploadDocument.isPending}
            accessibilityLabel={t('registration.documents.uploadAccessibility', {
              document: t('registration.vehicle.photoLabel'),
            })}
            onPress={() => {
              setPhotoError(null);
              setPhotoUploadState('idle');
              setPhotoSheetOpen(true);
            }}
          />
        </Reveal>
      </View>

      {photoSheetOpen ? (
        <RegistrationDocumentSheet
          visible
          onClose={() => {
            if (photoUploadState !== 'uploading') {
              setPhotoSheetOpen(false);
            }
          }}
          documentLabel={t('registration.vehicle.photoLabel')}
          documentType={photoBackendType}
          uploadState={photoUploadState}
          errorMessage={photoError ? toErrorMessage(photoError, t) : undefined}
          onPick={(source) => imagePicker.pick(source)}
          // La foto del vehículo NO es un documento con bordes, pero ofrecemos el MISMO escáner para
          // mantener una sola superficie de captura: el nativo igual encuadra/recorta y, si no aplica
          // bien o no está disponible (E_UNAVAILABLE), el conductor cae a la galería sin fricción. No
          // se justifica una cámara aparte solo para esta foto: reúsa el sheet + el pipeline de subida.
          onScan={() => documentScanner.scan()}
          onSubmit={onSubmitPhoto}
        />
      ) : null}
    </SafeScreen>
    <RegistrationExitSheet exit={back.exit} />
    </>
  );
};

const styles = StyleSheet.create({
  body: { paddingTop: 12 },
  intro: { gap: 6 },
  form: {},
});
