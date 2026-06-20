import React, { useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import { VehicleType } from '@veo/shared-types';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { IconCheck } from '../../../../shared/presentation/icons';
import { isConflictError, toErrorMessage } from '../../../../shared/presentation/errors';
import type { RegistrationStackParamList } from '../../../../navigation/types';
import { RegistrationStep, type VehicleErrors } from '../../domain';
import { REGISTRATION_TOTAL_STEPS, useRegistrationStore } from '../state/registrationStore';
import { useRegistrationStepBack } from '../hooks/useRegistrationStepBack';
import {
  REGISTRATION_VEHICLES_QUERY_KEY,
  useDriverVehicles,
} from '../hooks/useRegistrationWizard';
import { useVehicleContinue } from '../hooks/useVehicleContinue';
import type { PropertyCardScanOutcome } from '../hooks/useScanPropertyCard';
import {
  REGISTRATION_DOCUMENTS_QUERY_KEY,
  useRegistrationDocuments,
  useUploadAndRegisterDocument,
} from '../hooks/useRegistrationDocuments';
import { useDocumentScanner, useImagePicker } from '../../../../core/di/useDi';
import {
  DocumentUploadCard,
  hexAlpha,
  RegistrationDocumentSheet,
  RegistrationExitSheet,
  RegistrationField,
  RegistrationHeader,
  RegistrationProgress,
  ScanPropertyCardSheet,
  VehicleStatusCard,
  VehicleTypeSelector,
  type DocumentCardTone,
} from '../components';
import type {
  DocumentUploadState,
  RegistrationDocumentInput,
} from '../components/RegistrationDocumentSheet';
import { IconCar, IconShield } from '../../../../shared/presentation/icons';
import {
  DocumentUploadStatus,
  isAcceptableServerDocStatus,
  registrationDocTypeToBackend,
  type RegistrationDocumentServerStatus,
} from '../../domain';

type Props = NativeStackScreenProps<RegistrationStackParamList, 'Vehicle'>;

/** Tono del chip del SOAT según el `simpleStatus` real del documento (espeja el dominio de documentos). */
function soatStatusTone(status: RegistrationDocumentServerStatus): DocumentCardTone {
  switch (status) {
    case 'vigente':
      return 'success';
    case 'por_vencer':
      return 'warn';
    case 'vencido':
    case 'rechazado':
      return 'danger';
    case 'en_revision':
    default:
      return 'neutral';
  }
}

/**
 * Paso 2 del alta · SCAN-FIRST (Lote 2 · onboarding sin formularios). La acción PRINCIPAL es ESCANEAR la
 * tarjeta de propiedad: el OCR lee placa/marca/modelo/año y DERIVA el tipo de vehículo de la categoría MTC
 * (M1→auto, L*→moto). Lo leído se muestra en una tarjeta "Tarjeta capturada ✓" READ-ONLY. modelSpecId es
 * OPCIONAL en el contrato → la marca/modelo del OCR viajan a TEXTO LIBRE (el fuzzy-match a catálogo es
 * Lote 3). El formulario manual (tipo/placa/año/marca/modelo) queda como FALLBACK accesible: se ofrece si
 * el escaneo falla, no está disponible, o la categoría no es soportada — NUNCA es el camino por defecto.
 *
 * Degradación HONESTA: si el OCR NO leyó la PLACA (campo crítico) se ofrece reescanear o un input mínimo
 * SOLO para la placa (nunca se inventa). Categoría no soportada (N1 furgón / M2·M3 buses / *SC ambulancia)
 * → selector manual de tipo (ampliar el enum `VehicleType` para esas categorías es un lote futuro). La FOTO
 * del vehículo se mantiene EXACTAMENTE igual (cámara normal, sin OCR). POST /drivers/vehicles + GET.
 *
 * LOTE B (reagrupación por DUEÑO del documento): este paso reúne la documentación del VEHÍCULO. Además de la
 * tarjeta de propiedad (scan-first) y la foto, AHORA captura el SOAT (bajado del viejo paso "Documentos"),
 * reusando el componente CANÓNICO `RegistrationDocumentSheet` + el parser `parseSoat`. El SOAT es un
 * documento DRIVER-scoped (igual que la foto): se sube/registra al capturarlo (mismo pipeline que la foto).
 * El gating de "Registrar vehículo"/"Continuar" exige tarjeta (datos del vehículo) + foto + SOAT.
 */
export const VehicleScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const vehicle = useRegistrationStore((s) => s.vehicle);
  const setVehicle = useRegistrationStore((s) => s.setVehicle);
  const setVehicleType = useRegistrationStore((s) => s.setVehicleType);
  const setCurrentStep = useRegistrationStore((s) => s.setCurrentStep);
  // La tarjeta escaneada (imagen) es la fuente de verdad de "se capturó una tarjeta" INDEPENDIENTE del OCR.
  const pendingPropertyCard = useRegistrationStore((s) => s.pendingPropertyCard);

  // Back robusto del paso: reconstruye la pila al reanudar y nunca dispara un GO_BACK muerto.
  const back = useRegistrationStepBack();

  // Rehidrata el vehículo ya registrado (si existe) para mostrar su estado y bloquear el re-alta.
  const vehiclesQuery = useDriverVehicles();
  const existingVehicle = vehiclesQuery.data?.[0] ?? null;

  // Orquesta el continue: POST /drivers/vehicles (crea el vehículo) → subida DIFERIDA de la tarjeta de
  // propiedad escaneada (con su `extractedData`), 409-como-éxito. Mismo patrón que el DNI del paso 1.
  const vehicleContinue = useVehicleContinue();

  const [errors, setErrors] = useState<VehicleErrors>({});
  const [serverError, setServerError] = useState<unknown>(null);
  // El vehículo se creó pero la subida DIFERIDA de la tarjeta falló (no 409). NO perdemos la imagen
  // (sigue en `pendingPropertyCard`): aviso + reintento al volver a tocar Registrar (alta idempotente).
  const [cardUploadFailed, setCardUploadFailed] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  // El conductor pidió cargar a mano (fallback accesible): muestra el formulario completo (placa/año/
  // marca/modelo + el selector de tipo). NO es el camino por defecto: el scan-first manda.
  const [manualMode, setManualMode] = useState(false);

  // Foto del vehículo (Ola 1): se captura ACÁ reusando el pipeline de documentos. Se registra como doc
  // DRIVER-scoped (VEHICLE_PHOTO) y es REQUERIDA para aprobar. NO SE TOCA (cámara normal, sin OCR).
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

  // SOAT (LOTE B · doc del VEHÍCULO, bajado del viejo paso Documentos): documento numerado que VENCE. Se
  // captura con el componente CANÓNICO `RegistrationDocumentSheet` + el parser `parseSoat`. Es DRIVER-scoped
  // (como la foto): se sube/registra al capturarlo (NO necesita el vehículo creado; solo el driver, que ya
  // existe tras el paso 1). Requerido para avanzar.
  const soatBackendType = registrationDocTypeToBackend('SOAT');
  const [soatSheetOpen, setSoatSheetOpen] = useState(false);
  const [soatUploadState, setSoatUploadState] = useState<DocumentUploadState>('idle');
  const [soatError, setSoatError] = useState<unknown>(null);

  /** ¿El servidor YA tiene el SOAT en un estado aceptable? (conductor que vuelve/reinstala). */
  const serverHasSoat =
    serverDocs.data?.some(
      (doc) => doc.type === soatBackendType && isAcceptableServerDocStatus(doc.status),
    ) ?? false;
  const soatUploaded =
    documents.find((d) => d.type === 'SOAT')?.status === DocumentUploadStatus.UPLOADED ||
    serverHasSoat;

  /** Estado de SERVIDOR del SOAT para el chip (si existe en `GET /drivers/me/documents`). */
  const soatServerState = (() => {
    const match = serverDocs.data?.find((doc) => doc.type === soatBackendType);
    if (!match) {
      return undefined;
    }
    return {
      label: t(`documents.status.${match.simpleStatus}`),
      tone: soatStatusTone(match.simpleStatus),
    };
  })();

  // ¿Se capturó una tarjeta? (señal = imagen, NO los campos OCR). ¿El OCR leyó la PLACA (campo crítico)?
  const hasCapture = pendingPropertyCard != null;
  const hasReadPlate = vehicle.plate.trim().length > 0;
  // ¿El AÑO está presente? El scan SOLO prellena el año si cae en el rango VÁLIDO del contrato (ver
  // `useScanPropertyCard`): un año fuera de rango/no leído deja el campo VACÍO → corregible en el scan. (FIX 4)
  const hasReadYear = vehicle.year.trim().length > 0;
  // Datos mínimos para registrar: placa + año + (modelo del catálogo o marca+modelo a texto libre).
  const hasModel =
    vehicle.modelSpecId.trim().length > 0 ||
    (vehicle.brand.trim().length > 0 && vehicle.model.trim().length > 0);
  // Para registrar: placa + año + modelo Y un TIPO definido (LOTE 1: sin seed "Auto"). El tipo viene
  // DERIVADO de la categoría MTC de la tarjeta, o elegido a mano en el fallback. Si `vehicle.type` sigue en
  // `null` (no se derivó ni se eligió) NO se puede registrar: nunca un "Auto" silencioso.
  const hasType = vehicle.type !== null;
  const hasVehicleData = hasReadPlate && hasReadYear && hasModel && hasType;

  /** Actualiza un campo del vehículo y limpia su error inline. */
  const update = (patch: Partial<typeof vehicle>, field: keyof VehicleErrors) => {
    setVehicle(patch);
    if (errors[field]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  /** Sube+registra la foto del vehículo (reusa el pipeline de documentos; sin número ni vencimiento). */
  const onSubmitPhoto = async (input: RegistrationDocumentInput) => {
    setPhotoError(null);
    setPhotoUploadState('uploading');
    try {
      await uploadDocument.mutateAsync({ type: photoBackendType, file: input.file });
      setDocumentStatus('VEHICLE_PHOTO', 'uploaded');
      setPhotoUploadState('success');
      setTimeout(() => {
        setPhotoSheetOpen(false);
        setPhotoUploadState('idle');
      }, 900);
    } catch (e) {
      // Retry legítimo del "subí y listo": la foto YA fue registrada en un intento previo y el backend
      // responde 409 ConflictError (un VEHICLE_PHOTO activo ya existe para el conductor). La foto YA está
      // → es ÉXITO, no error: marcamos el doc como `uploaded` (mismo mecanismo que el éxito normal, que
      // habilita "Registrar vehículo" vía `photoUploaded`), cerramos el sheet y NO mostramos error.
      // Detectado por status 409 tipado (`isConflictError`), no por el texto del mensaje. MISMO patrón que
      // `useVehicleContinue.uploadPendingCard` (tarjeta) y el DNI (usePersonalDataContinue).
      if (isConflictError(e)) {
        setDocumentStatus('VEHICLE_PHOTO', 'uploaded');
        // Reconcilia el estado de SERVIDOR: el 409 prueba que el doc YA existe del lado del servidor, pero
        // `serverDocs` puede estar stale (no se hizo el `onSuccess` que invalida). Invalidamos la MISMA key
        // que el `onSuccess` de `useUploadAndRegisterDocument`/`useRegistrationDocuments` → el listado se
        // refetchea y `photoUploaded` queda respaldado por el servidor, no solo por el flag local.
        void queryClient.invalidateQueries({ queryKey: REGISTRATION_DOCUMENTS_QUERY_KEY });
        setPhotoUploadState('success');
        setTimeout(() => {
          setPhotoSheetOpen(false);
          setPhotoUploadState('idle');
        }, 900);
        return;
      }
      setPhotoError(e);
      setPhotoUploadState('error');
    }
  };

  /** Sube+registra el SOAT (reusa el componente CANÓNICO + el parser `parseSoat`). DRIVER-scoped, inmediato. */
  const onSubmitSoat = async (input: RegistrationDocumentInput) => {
    setSoatError(null);
    setSoatUploadState('uploading');
    try {
      await uploadDocument.mutateAsync({
        type: soatBackendType,
        file: input.file,
        ...(input.documentNumber ? { documentNumber: input.documentNumber } : {}),
        ...(input.expiresAtIso ? { expiresAt: input.expiresAtIso } : {}),
        ...(input.extractedData ? { extractedData: input.extractedData } : {}),
        ...(input.ocrEngine ? { ocrEngine: input.ocrEngine } : {}),
        ...(input.ocrAt ? { ocrAt: input.ocrAt } : {}),
      });
      markSoatCaptured();
    } catch (e) {
      // 409 = el SOAT YA fue registrado en un intento previo → ÉXITO, no error (mismo patrón que la foto/
      // tarjeta/DNI). Reconcilia el estado de servidor invalidando el listado y marca el doc subido.
      if (isConflictError(e)) {
        void queryClient.invalidateQueries({ queryKey: REGISTRATION_DOCUMENTS_QUERY_KEY });
        markSoatCaptured();
        return;
      }
      setSoatError(e);
      setSoatUploadState('error');
    }
  };

  /** Marca el SOAT como capturado (subido) y cierra el sheet tras mostrar el check de éxito. */
  function markSoatCaptured(): void {
    setDocumentStatus('SOAT', DocumentUploadStatus.UPLOADED);
    setSoatUploadState('success');
    setTimeout(() => {
      setSoatSheetOpen(false);
      setSoatUploadState('idle');
    }, 900);
  }

  const goNext = () => {
    setCurrentStep(RegistrationStep.IDENTITY_VERIFICATION);
    navigation.navigate('IdentityVerification');
  };

  /**
   * Resuelve el camino tras un escaneo CAPTURADO (LOTE 1 · la tarjeta es la fuente de verdad del tipo):
   *  - Tipo DERIVADO (`derivedType != null`: Moto si L*, Auto si M1): el hook YA fijó `vehicle.type` en el
   *    store. La pantalla lo muestra como FILA READ-ONLY ("Tipo de vehículo: Moto"), igual que las otras
   *    filas de la tarjeta capturada — SIN selector (no es editable: la tarjeta manda).
   *  - Tipo NO derivado (`derivedType == null`: categoría no leída o no soportada N1/M2/M3/*SC): el tipo
   *    del store queda en `null` (sin seed "Auto"). Cae al VehicleTypeSelector de FALLBACK, que ofrece AMBOS
   *    tipos (CAR|MOTO) y bloquea Registrar hasta que el conductor elija (vía `hasType`). Nunca "Auto" mudo.
   *  - Año NO leído o fuera de rango: el año quedó vacío → input de año corregible en el camino scan.
   */
  const onCaptured = (_outcome: PropertyCardScanOutcome) => {
    setScanOpen(false);
    // No hace falta estado extra: el tipo derivado (o su ausencia) vive en `vehicle.type` (store, reactivo).
    // La pantalla deriva read-only vs selector-fallback de `vehicle.type !== null`.
  };

  /** El conductor eligió el tipo a mano en el FALLBACK (categoría no derivable). */
  const onChangeVehicleType = (type: VehicleType) => {
    setVehicleType(type);
  };

  /** Etiqueta i18n del tipo de vehículo (para la fila read-only de la tarjeta capturada). */
  const vehicleTypeLabel = (type: VehicleType): string =>
    type === VehicleType.MOTO
      ? t('registration.vehicle.typeMoto')
      : t('registration.vehicle.typeCar');

  const onContinue = async () => {
    // Si ya hay un vehículo registrado (en revisión), solo avanzamos: no se vuelve a registrar.
    if (existingVehicle) {
      goNext();
      return;
    }
    if (vehicleContinue.isPending) {
      return;
    }
    setErrors({});
    setServerError(null);
    setCardUploadFailed(false);

    // El hook orquesta el alta del vehículo → subida DIFERIDA de la tarjeta escaneada (con OCR). El
    // resultado discriminado dice exactamente qué pintar (sin strings mágicos) y si se puede avanzar.
    const result = await vehicleContinue.submit(vehicle);
    switch (result.status) {
      case 'ok':
        queryClient.invalidateQueries({ queryKey: REGISTRATION_VEHICLES_QUERY_KEY });
        goNext();
        return;
      case 'field-errors':
        setErrors(result.errors);
        return;
      case 'plate-taken':
        // 409 del alta = la placa pertenece a OTRO conductor → error INLINE del campo placa (accionable).
        setErrors({ plate: 'plate_taken' });
        return;
      case 'server-error':
        setServerError(result.error);
        return;
      case 'card-upload-failed':
        setCardUploadFailed(true);
        return;
    }
  };

  /** Traduce un código de error de campo a su mensaje. */
  const fieldError = (field: keyof VehicleErrors): string | undefined => {
    const code = errors[field];
    return code ? t(`registration.vehicle.errors.${code}`) : undefined;
  };

  // ¿La captura del scan rindió una tarjeta usable (con placa)? Entonces mostramos la tarjeta "capturada".
  const derivedFromScan = hasCapture && hasReadPlate;
  const showManualForm = manualMode;

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
            loading={vehicleContinue.isPending}
            // LOTE B: la foto Y el SOAT del vehículo son REQUERIDOS para avanzar (alta nueva Y vehículo ya
            // registrado). Espejan el gating de la documentación del vehículo agrupada en este paso.
            disabled={(!existingVehicle && !hasVehicleData) || !photoUploaded || !soatUploaded}
            onPress={() => {
              void onContinue();
            }}
          />
        }
      >
        <View style={[styles.body, { gap: theme.spacing.xl }]}>
          <Reveal>
            <RegistrationProgress current={2} />
          </Reveal>

          <Reveal delay={40} style={styles.intro}>
            <Text variant="caption" color="inkMuted" align="center">
              {t('registration.stepOf', { current: 2, total: REGISTRATION_TOTAL_STEPS })}
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

          {cardUploadFailed ? (
            <Reveal>
              <Banner
                tone="danger"
                title={t('registration.vehicle.scanCard.uploadFailed')}
                description={t('registration.vehicle.scanCard.uploadRetryHint')}
              />
            </Reveal>
          ) : null}

          {existingVehicle ? (
            <Reveal delay={100} spring>
              <VehicleStatusCard vehicle={existingVehicle} />
            </Reveal>
          ) : (
            <>
              {/* Acción PRINCIPAL: escanear la tarjeta de propiedad. El OCR lee los datos y deriva el tipo. */}
              <Reveal delay={100} from="scale">
                <Button
                  label={
                    hasCapture
                      ? t('registration.vehicle.scanCard.rescan')
                      : t('registration.vehicle.scanCard.cta')
                  }
                  variant={hasCapture ? 'secondary' : 'accent'}
                  fullWidth
                  onPress={() => setScanOpen(true)}
                />
              </Reveal>

              {/* TARJETA "Tarjeta capturada ✓" MINIMALISTA: miniatura + tilde + datos leídos (read-only). Se
                  muestra cuando hay captura Y la placa crítica se leyó: parece OK SOLO cuando lo está. */}
              {derivedFromScan && pendingPropertyCard ? (
                <Reveal delay={140} from="scale">
                  <View
                    style={[
                      styles.capturedCard,
                      {
                        backgroundColor: hexAlpha(theme.colors.success, 0.1),
                        borderColor: hexAlpha(theme.colors.success, 0.4),
                        borderRadius: theme.radii.lg,
                        padding: theme.spacing.md,
                        gap: theme.spacing.md,
                      },
                    ]}
                  >
                    <Image
                      source={{ uri: pendingPropertyCard.front.uri }}
                      style={[styles.capturedThumb, { borderRadius: theme.radii.md }]}
                      resizeMode="cover"
                      accessibilityIgnoresInvertColors
                    />
                    <View style={[styles.capturedBody, { gap: theme.spacing.sm }]}>
                      <View style={[styles.capturedHeader, { gap: theme.spacing.xs }]}>
                        <IconCheck size={20} color={theme.colors.success} strokeWidth={2.6} />
                        <Text variant="headline" color="success">
                          {t('registration.vehicle.scanCard.capturedTitle')}
                        </Text>
                      </View>
                      <ReadRow label={t('registration.vehicle.scanCard.readPlate')} value={vehicle.plate} />
                      {/* LOTE 1: el TIPO DERIVADO de la categoría MTC es una fila READ-ONLY (la tarjeta es la
                          fuente de verdad), igual que placa/marca/año — SIN selector. Solo cuando la tarjeta
                          NO lo derivó (`vehicle.type === null`) cae al VehicleTypeSelector de fallback (abajo). */}
                      {vehicle.type !== null ? (
                        <ReadRow
                          label={t('registration.vehicle.scanCard.readType')}
                          value={vehicleTypeLabel(vehicle.type)}
                        />
                      ) : null}
                      {`${vehicle.brand} ${vehicle.model}`.trim().length > 0 ? (
                        <ReadRow
                          label={t('registration.vehicle.scanCard.readVehicle')}
                          value={`${vehicle.brand} ${vehicle.model}`.trim()}
                        />
                      ) : null}
                      {vehicle.year.trim().length > 0 ? (
                        <ReadRow label={t('registration.vehicle.scanCard.readYear')} value={vehicle.year} />
                      ) : null}
                    </View>
                  </View>
                </Reveal>
              ) : null}

              {/* Fallback HONESTO del campo CRÍTICO: se capturó la foto pero el OCR NO leyó la placa →
                  reescaneo O un input mínimo SOLO para la placa (NUNCA se inventa). Se gatilla por la
                  captura, no por los campos OCR. */}
              {hasCapture && !hasReadPlate ? (
                <Reveal delay={120}>
                  <View style={{ gap: theme.spacing.md }}>
                    <Banner
                      tone="warn"
                      title={t('registration.vehicle.scanCard.criticalMissingTitle')}
                      description={t('registration.vehicle.scanCard.criticalMissingBody')}
                    />
                    <RegistrationField
                      label={t('registration.vehicle.scanCard.plateOnlyLabel')}
                      placeholder={t('registration.vehicle.platePlaceholder')}
                      value={vehicle.plate}
                      onChangeText={(text) => update({ plate: text.toUpperCase() }, 'plate')}
                      autoCapitalize="characters"
                      maxLength={8}
                      error={fieldError('plate')}
                    />
                  </View>
                </Reveal>
              ) : null}

              {/* Fallback HONESTO del AÑO: la tarjeta se capturó CON placa, pero el OCR no leyó un año VÁLIDO
                  (no se leyó, o cayó fuera del rango del contrato y por eso NO se prellenó). En vez de fingir
                  "capturada ✓" y reventar con `year_invalid` al Registrar, ofrecemos un input de año
                  CORREGIBLE acá mismo (sin obligar a descubrir el toggle manual). Solo en el camino scan: el
                  formulario manual ya trae su propio campo de año. (FIX 4) */}
              {hasCapture && hasReadPlate && !hasReadYear && !manualMode ? (
                <Reveal delay={130}>
                  <View style={{ gap: theme.spacing.md }}>
                    <Banner
                      tone="warn"
                      title={t('registration.vehicle.scanCard.yearMissingTitle')}
                      description={t('registration.vehicle.scanCard.yearMissingBody')}
                    />
                    <RegistrationField
                      label={t('registration.vehicle.yearLabel')}
                      placeholder={t('registration.vehicle.yearPlaceholder')}
                      value={vehicle.year}
                      onChangeText={(text) => update({ year: text }, 'year')}
                      keyboardType="number-pad"
                      maxLength={4}
                      error={fieldError('year')}
                    />
                  </View>
                </Reveal>
              ) : null}

              {/* SELECTOR DE TIPO de FALLBACK en el camino SCAN (LOTE 1): SOLO aparece cuando la tarjeta NO
                  derivó el tipo (`vehicle.type === null`: categoría no leída o no soportada N1/M2/M3/*SC). Si
                  la derivó, el tipo es una FILA READ-ONLY en la tarjeta capturada (arriba) y este selector NO
                  se muestra (la tarjeta manda). Ofrece AMBOS tipos (CAR|MOTO) y un banner pide elegirlo;
                  Registrar queda BLOQUEADO hasta que el conductor toque una opción (vía `hasType`, reactivo
                  por Zustand). Nunca un "Auto" por omisión. El formulario manual trae su propio selector. */}
              {derivedFromScan && !manualMode && vehicle.type === null ? (
                <Reveal delay={150} from="scale">
                  <View style={{ gap: theme.spacing.md }}>
                    <Banner
                      tone="warn"
                      title={t('registration.vehicle.scanCard.typeNeedsConfirmTitle')}
                      description={t('registration.vehicle.scanCard.typeNeedsConfirmBody')}
                    />
                    <VehicleTypeSelector value={vehicle.type} onChange={onChangeVehicleType} />
                  </View>
                </Reveal>
              ) : null}

              {/* Toggle del fallback manual (accesible, NO por defecto). Oculto cuando el scan capturó bien
                  con tipo soportado (ahí el camino es escanear/reescanear). */}
              {!manualMode ? (
                <Reveal delay={160}>
                  <Button
                    label={t('registration.vehicle.manualToggle')}
                    variant="ghost"
                    fullWidth
                    onPress={() => setManualMode(true)}
                  />
                </Reveal>
              ) : null}

              {/* FORMULARIO MANUAL (fallback): tipo + placa + año + marca/modelo a texto libre. Solo aparece
                  cuando el conductor lo pide (toggle) o cae acá por categoría no soportada / escáner ausente.
                  Marca/modelo van a TEXTO LIBRE (sin catálogo) — coherente con la rama del contrato. */}
              {showManualForm ? (
                <View style={[styles.form, { gap: theme.spacing.lg }]}>
                  {/* Carga a mano (fallback): el selector de tipo ofrece AMBOS tipos (CAR|MOTO). Arranca sin
                      selección (`null`) — Registrar queda bloqueado hasta elegir (sin "Auto" por omisión). */}
                  <Reveal delay={100}>
                    <VehicleTypeSelector value={vehicle.type} onChange={onChangeVehicleType} />
                  </Reveal>
                  {vehicle.type === null ? (
                    <Reveal delay={110}>
                      <Text variant="footnote" color="inkMuted">
                        {t('registration.vehicle.scanCard.typePrompt')}
                      </Text>
                    </Reveal>
                  ) : null}

                  <Reveal delay={150} from="scale">
                    <RegistrationField
                      label={t('registration.vehicle.modelRequestMake')}
                      placeholder={t('registration.vehicle.modelRequestMake')}
                      value={vehicle.brand}
                      onChangeText={(text) => update({ brand: text, modelSpecId: '' }, 'model')}
                      maxLength={60}
                      error={fieldError('model')}
                    />
                  </Reveal>

                  <Reveal delay={170} from="scale">
                    <RegistrationField
                      label={t('registration.vehicle.modelRequestModel')}
                      placeholder={t('registration.vehicle.modelRequestModel')}
                      value={vehicle.model}
                      onChangeText={(text) => update({ model: text, modelSpecId: '' }, 'model')}
                      maxLength={60}
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
              ) : null}
            </>
          )}

          {/* Foto del vehículo (Ola 1): se captura ACÁ, es REQUERIDA para aprobar. Cámara normal (sin OCR).
              NO SE TOCA: reusa el sheet de captura + el pipeline de subida de documentos (foto sin número). */}
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

          {/* SOAT (LOTE B · doc del VEHÍCULO, bajado del viejo paso Documentos). Reusa el componente
              CANÓNICO `RegistrationDocumentSheet` + el parser `parseSoat`. Documento numerado que vence;
              DRIVER-scoped, se sube/registra al capturarlo. REQUERIDO para avanzar. */}
          <Reveal delay={270}>
            <DocumentUploadCard
              icon={<IconShield size={26} color={theme.colors.accent} strokeWidth={1.8} />}
              label={t('registration.documents.soat')}
              status={soatUploaded ? DocumentUploadStatus.UPLOADED : DocumentUploadStatus.PENDING}
              uploadedLabel={t('registration.documents.uploaded')}
              pendingLabel={t('registration.documents.pending')}
              serverState={soatServerState}
              busy={uploadDocument.isPending}
              accessibilityLabel={t('registration.documents.uploadAccessibility', {
                document: t('registration.documents.soat'),
              })}
              onPress={() => {
                setSoatError(null);
                setSoatUploadState('idle');
                setSoatSheetOpen(true);
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
            // La foto del vehículo es una FOTO LIBRE: el sheet entra en modo `'photo'` y su acción
            // principal es la cámara normal vía `onPick`, SIN escáner de bordes ni OCR. Por eso no se
            // inyecta `onScan`. El pipeline de subida (presign + PUT + registro) es el mismo.
            onPick={(source) => imagePicker.pick(source)}
            onSubmit={onSubmitPhoto}
          />
        ) : null}

        {soatSheetOpen ? (
          <RegistrationDocumentSheet
            visible
            onClose={() => {
              if (soatUploadState !== 'uploading') {
                setSoatSheetOpen(false);
              }
            }}
            documentLabel={t('registration.documents.soat')}
            // El tipo CANÓNICO selecciona la config contextual del formulario (etiqueta del número + que
            // vence) y el parser de OCR (`parseSoat`). El mapeo es el mismo que viaja al backend.
            documentType={soatBackendType}
            uploadState={soatUploadState}
            errorMessage={soatError ? toErrorMessage(soatError, t) : undefined}
            onPick={(source) => imagePicker.pick(source)}
            onScan={() => documentScanner.scan()}
            onSubmit={onSubmitSoat}
          />
        ) : null}
      </SafeScreen>
      <ScanPropertyCardSheet
        visible={scanOpen}
        onClose={() => setScanOpen(false)}
        onCaptured={onCaptured}
      />
      <RegistrationExitSheet exit={back.exit} />
    </>
  );
};

/** Fila read-only "etiqueta · valor" de lo leído por el OCR (mismo estilo minimalista que el DNI). */
function ReadRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.readRow, { gap: theme.spacing.sm }]}>
      <Text variant="footnote" color="inkMuted">
        {label}
      </Text>
      {value.length > 0 ? (
        <Text variant="footnote" color="ink" style={styles.readValue}>
          {value}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingTop: 12 },
  intro: { gap: 6 },
  form: {},
  capturedCard: { borderWidth: 1, flexDirection: 'row', alignItems: 'center' },
  capturedThumb: { width: 96, height: 96 },
  capturedBody: { flex: 1 },
  capturedHeader: { flexDirection: 'row', alignItems: 'center' },
  readRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  readValue: { flexShrink: 1, textAlign: 'right' },
});
