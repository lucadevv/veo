import React, { useEffect } from 'react';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner, BottomSheet, Button, Text, useTheme } from '@veo/ui-kit';
import { VehicleType } from '@veo/shared-types';
import { IconCheck } from '../../../../shared/presentation/icons';
import { DOCUMENT_CARD_ASPECT_RATIO, scanMessageI18nKey } from '../../../documents/domain';
import { hexAlpha } from '../../../../shared/presentation/color';
import { useScanPropertyCard, type PropertyCardScanOutcome } from '../hooks/useScanPropertyCard';

/**
 * Sheet de captura de la TARJETA DE PROPIEDAD por ESCANEO (Lote 2 · scan-first del paso 2). Espejo de
 * `ScanDniSheet`: escanea UNA página, corre el OCR (`parsePropertyCard`), DERIVA el tipo de vehículo de
 * la categoría MTC, PRELLENA de forma NO destructiva los datos del vehículo (solo campos vacíos) y deja
 * la imagen + la data OCR pendientes para la subida DIFERIDA tras crear el vehículo.
 *
 * Estados HONESTOS (vía `useScanPropertyCard`): nunca se marca éxito sin que el escaneo haya resuelto. El
 * campo CRÍTICO es la PLACA: si el OCR no la leyó, NO se muestra un "capturado ✓" que finge éxito → la
 * pantalla ofrece reescaneo o un input mínimo SOLO para la placa (en `VehicleScreen`). Degradación honesta:
 * el escáner no disponible avisa y deja la carga manual; categoría no soportada cae al selector de tipo.
 */
export interface ScanPropertyCardSheetProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Se invoca cuando el escaneo capturó con éxito (la pantalla cierra el sheet y muestra la tarjeta). Lleva
   * el `PropertyCardScanOutcome` para que la pantalla DECIDA el camino: categoría no soportada
   * (`mtcUnsupported`) o año no leído/fuera de rango (`autofilled.year === false`) exigen corrección manual.
   */
  onCaptured?: (outcome: PropertyCardScanOutcome) => void;
}

export function ScanPropertyCardSheet({
  visible,
  onClose,
  onCaptured,
}: ScanPropertyCardSheetProps): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  const card = useScanPropertyCard();

  // Limpia el flujo cada vez que el sheet se abre (captura fresca, sin arrastrar un escaneo previo).
  useEffect(() => {
    if (visible) {
      card.reset();
    }
    // `card.reset` es estable por render del hook; solo reaccionamos a la apertura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const isScanning = card.state === 'scanning';
  const isCaptured = card.state === 'captured';
  const isError = card.state === 'error';
  const busy = isScanning;

  // Campo CRÍTICO de la tarjeta: la PLACA. Si el OCR no la leyó, NO mostramos "capturado ✓": la pantalla
  // gatilla el fallback (reescaneo / input solo-placa). La señal es la placa en el store tras la captura.
  const hasReadPlate = card.vehicle.plate.trim().length > 0;

  /** Escanea la tarjeta (el hook corre el OCR, deriva el tipo y prellena el store de forma no destructiva). */
  const runScan = async (): Promise<void> => {
    const outcome = await card.scan();
    if (outcome) {
      onCaptured?.(outcome);
    }
  };

  const canConfirm = isCaptured && card.front != null && hasReadPlate;
  const onPrimary = (): void => {
    if (canConfirm) {
      // Captura con placa leída: el primario CONFIRMA (cierra el sheet; los datos ya están en el store).
      onClose();
      return;
    }
    // Sin captura, captura sin placa crítica, o error de escaneo → (re)escanear. NUNCA confirmamos una
    // tarjeta sin su placa: sería un éxito fingido. Honestidad de estado.
    void runScan();
  };

  const primaryLabel = canConfirm
    ? t('registration.actions.useCard')
    : card.front
      ? t('registration.actions.rescan')
      : t('registration.vehicle.scanCard.cta');

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('registration.vehicle.scanCard.title')}
      footer={
        <View style={styles.footer}>
          <Button
            label={t('common.cancel')}
            variant="secondary"
            onPress={onClose}
            disabled={busy}
          />
          <Button
            label={primaryLabel}
            variant="primary"
            loading={busy}
            disabled={busy}
            onPress={onPrimary}
          />
        </View>
      }
    >
      <View style={[styles.body, { gap: theme.spacing.lg }]}>
        <Text variant="footnote" color="inkSubtle">
          {t('registration.vehicle.scanCard.hint')}
        </Text>

        {/* Preview de la tarjeta capturada (placeholder hasta capturarla). */}
        <CardPreview
          label={t('registration.vehicle.scanCard.preview')}
          uri={card.front?.uri ?? null}
          scanning={isScanning}
        />

        {/* "Tarjeta capturada ✓" MINIMALISTA: tilde + título + lo que se leyó (read-only). Se muestra SOLO
            cuando la placa crítica se leyó (captura realmente válida). */}
        {isCaptured && hasReadPlate ? (
          <View
            style={[
              styles.capturedCard,
              {
                backgroundColor: hexAlpha(theme.colors.success, 0.1),
                borderColor: hexAlpha(theme.colors.success, 0.4),
                borderRadius: theme.radii.lg,
                padding: theme.spacing.md,
                gap: theme.spacing.sm,
              },
            ]}
          >
            <View style={[styles.statusRow, { gap: theme.spacing.sm }]}>
              <IconCheck size={20} color={theme.colors.success} strokeWidth={2.6} />
              <Text variant="headline" color="success">
                {t('registration.vehicle.scanCard.capturedTitle')}
              </Text>
            </View>
            <ReadRow
              label={t('registration.vehicle.scanCard.readPlate')}
              value={card.vehicle.plate}
            />
            {card.derivedType !== null ? (
              <ReadRow
                label={t('registration.vehicle.typeAccessibility', {
                  type:
                    card.derivedType === VehicleType.MOTO
                      ? t('registration.vehicle.scanCard.typeMoto')
                      : t('registration.vehicle.scanCard.typeCar'),
                })}
                value=""
              />
            ) : null}
            {card.vehicle.brand.trim().length > 0 || card.vehicle.model.trim().length > 0 ? (
              <ReadRow
                label={t('registration.vehicle.scanCard.readVehicle')}
                value={`${card.vehicle.brand} ${card.vehicle.model}`.trim()}
              />
            ) : null}
            {card.vehicle.year.trim().length > 0 ? (
              <ReadRow
                label={t('registration.vehicle.scanCard.readYear')}
                value={card.vehicle.year}
              />
            ) : null}
          </View>
        ) : null}

        {/* Fallback HONESTO del campo CRÍTICO: se capturó la foto pero el OCR NO leyó la placa → reescaneo
            (NO una tarjeta vacía que finge éxito). Se gatilla por la captura, no por los campos OCR. El
            input solo-placa lo ofrece `VehicleScreen` (acá pedimos reescaneo). */}
        {isCaptured && !hasReadPlate ? (
          <Banner
            tone="warn"
            title={t('registration.vehicle.scanCard.criticalMissingTitle')}
            description={t('registration.vehicle.scanCard.criticalMissingBody')}
          />
        ) : null}

        {/* Categoría MTC no soportada (N1/M2/M3/*SC): la pantalla mostrará el selector manual de tipo. */}
        {isCaptured && card.mtcUnsupported ? (
          <Banner
            tone="warn"
            title={t('registration.vehicle.scanCard.unsupportedTitle')}
            description={t('registration.vehicle.scanCard.unsupportedBody')}
          />
        ) : null}

        {/* Degradación honesta: escáner no disponible → carga manual de los datos del vehículo. */}
        {card.unavailable ? (
          <Banner
            tone="warn"
            title={t('registration.documents.scanUnavailable')}
            description={t('registration.vehicle.scanCard.manualFallback')}
          />
        ) : null}

        {/* Mensaje accionable (cancelación/fallo de escaneo): el motivo TIPADO (`ScanMessage`) se mapea a
            su clave i18n con el mapper exhaustivo del dominio — sin comparar el valor contra literales. */}
        {card.message ? (
          <Banner
            tone={isError ? 'danger' : 'warn'}
            title={t('errors.generic')}
            description={t(scanMessageI18nKey(card.message))}
          />
        ) : null}
      </View>
    </BottomSheet>
  );
}

/** Fila read-only "etiqueta · valor" de lo leído por el OCR. Si no hay valor, muestra solo la etiqueta. */
function ReadRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.readRow}>
      <Text variant="footnote" color="inkMuted">
        {label}
      </Text>
      {value.length > 0 ? (
        <Text variant="footnote" color="ink">
          {value}
        </Text>
      ) : null}
    </View>
  );
}

/** Preview de la tarjeta: imagen capturada o placeholder con su etiqueta. */
function CardPreview({
  label,
  uri,
  scanning,
}: {
  label: string;
  uri: string | null;
  scanning: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.previewCol}>
      <View
        style={[
          styles.preview,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderColor: uri ? hexAlpha(theme.colors.accent, 0.5) : theme.colors.border,
            borderRadius: theme.radii.md,
          },
        ]}
      >
        {uri ? (
          <Image source={{ uri }} style={styles.previewImage} resizeMode="contain" />
        ) : (
          <View style={styles.previewEmpty}>
            {scanning ? (
              <ActivityIndicator color={theme.colors.accent} />
            ) : (
              <Text variant="caption" color="inkSubtle">
                {label}
              </Text>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: 8 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  previewCol: { gap: 6 },
  // Proporción de tarjeta ID-1: la tarjeta de propiedad se ve ENTERA, sin el zoom del cover.
  preview: {
    aspectRatio: DOCUMENT_CARD_ASPECT_RATIO,
    borderWidth: 1,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  previewImage: { width: '100%', height: '100%' },
  previewEmpty: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  capturedCard: { borderWidth: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  readRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
});
