import React, { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner, BottomSheet, Button, Text, useTheme } from '@veo/ui-kit';
import { IconAlert } from '../../../../shared/presentation/icons';
import { scanMessageI18nKey } from '../../../documents/domain';
import { deriveDocumentPhase, type DocumentFacePhases } from '../state/registrationStore';
import { hexAlpha } from '../../../../shared/presentation/color';
import { useScanDni } from '../hooks/useScanDni';
import {
  ScanExtractRow,
  ScanFacePreview,
  ScanSendingBar,
  ScanStatusLine,
  formatDocumentDate,
  scanSheetStyles as s,
} from './scanSheetParts';

/**
 * Sheet de captura del DNI por ESCANEO (paso 1 · flujo EAGER a imagen del frame `C/ScanDni` del pen):
 * escanea anverso + reverso, corre el OCR del frente, muestra lo LEÍDO (nombre/DNI/nacimiento) y, al
 * confirmar, dispara la subida INMEDIATA con estados POR CARA (subiendo azul → enviado verde / error rojo)
 * y el bloqueo rojo si el DNI YA está registrado en otra cuenta (`dniTaken`, del pre-check `check-dni`).
 *
 * Estados HONESTOS (vía `useScanDni` + las fases por-cara del store): nunca se marca un éxito que no
 * ocurrió. Degradación honesta: escáner no disponible → tipeo manual; reverso ausente se avisa; el OCR
 * sin número crítico cae a reescaneo. Reusa por DI el escáner + el parser + el pipeline de subida, y las
 * piezas visuales canónicas de `scanSheetParts` (mismo lenguaje que el sheet de la licencia).
 */
export interface ScanDniSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Fases de envío POR CARA del DNI (del store). El sheet pinta cada preview: azul=subiendo, verde=enviado, rojo=error. */
  facePhases: DocumentFacePhases;
  /** El DNI escaneado YA pertenece a otra cuenta (pre-check `check-dni`). Pinta el estado rojo de bloqueo. */
  dniTaken: boolean;
  /** Operación EAGER en curso (checkDni → PATCH → subir). Antes de que haya fase por cara, muestra "Verificando…". */
  submitting: boolean;
  /** El checkDni o el PATCH FALLARON (red/servidor, no duplicado): muestra el error + reintento (honestidad). */
  submitError: boolean;
  /** Confirma la captura y dispara la subida EAGER (checkDni → PATCH → subir DNI por cara). La orquesta la pantalla. */
  onConfirm: () => void;
  /** Limpia el estado de bloqueo (`dniTaken`) al reescanear otro documento. */
  onRescan: () => void;
}

export function ScanDniSheet({
  visible,
  onClose,
  facePhases,
  dniTaken,
  submitting,
  submitError,
  onConfirm,
  onRescan,
}: ScanDniSheetProps): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  const dni = useScanDni();

  // Al reabrir el sheet CONSERVA la captura ya leída (estado `captured` = el bloque "Esto leímos de tu DNI"):
  // así el conductor re-abre la card y REVISA lo que capturó (con "Usar este DNI" / "Volver a escanear"). Solo
  // limpia el flujo cuando NO hay una captura útil que mostrar (idle / error / escaneando / ya enviado).
  useEffect(() => {
    if (visible && dni.state !== 'captured') {
      dni.reset();
    }
    // `dni.reset` es estable por render del hook; solo reaccionamos a la apertura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const documentPhase = deriveDocumentPhase(facePhases);
  const isScanning = dni.state === 'scanning';
  const isCaptured = dni.state === 'captured';
  // `ready` = caras confirmadas: la subida ya arrancó (fases por cara vivas en el store).
  const isReady = dni.state === 'ready';
  const isError = dni.state === 'error';
  const busy = isScanning;

  // Estados de ENVÍO derivados de las fases POR CARA — solo relevantes tras confirmar (`ready`).
  const isSending = isReady && documentPhase === 'sending';
  const isSent = isReady && documentPhase === 'sent';
  const sendFailed = isReady && documentPhase === 'error';
  // Ventana checkDni + PATCH: confirmado (`ready`) y `submitting`, pero la subida por cara todavía NO arrancó
  // (fase `idle`). Sin esto el sheet quedaba MUDO fingiendo "listo" mientras corría la verificación/creación.
  const isChecking = submitting && isReady && documentPhase === 'idle' && !submitError;

  // Campo CRÍTICO del DNI: el número. Sin él (OCR borroso/ausente) NO fingimos "capturado": reescaneo.
  const hasReadDniNumber = dni.personal.dni.trim().length > 0;

  const canConfirm = isCaptured && dni.front != null && hasReadDniNumber;
  const onPrimary = (): void => {
    if (canConfirm) {
      dni.submit();
      onConfirm();
      return;
    }
    void dni.scan();
  };
  const rescan = (): void => {
    onRescan();
    dni.reset();
    void dni.scan();
  };

  const primaryLabel = canConfirm
    ? t('registration.actions.useDni')
    : dni.front
      ? t('registration.actions.rescan')
      : t('registration.personal.scanDni.cta');

  const footer = dniTaken ? (
    // DNI ya registrado en otra cuenta: la única salida sana es escanear OTRO documento.
    <Button
      label={t('registration.personal.scanDni.scanAnother')}
      variant="primary"
      fullWidth
      onPress={rescan}
    />
  ) : isSending || isChecking ? (
    // Verificando/subiendo: no te toma de rehén — "Continuar en segundo plano" cierra; la card sigue el progreso.
    <Button
      label={t('registration.documents.sheetBackground')}
      variant="secondary"
      fullWidth
      onPress={onClose}
    />
  ) : sendFailed || submitError ? (
    <View style={s.footer}>
      <Button label={t('common.close')} variant="secondary" onPress={onClose} />
      <Button label={t('registration.actions.retryUpload')} variant="primary" onPress={onConfirm} />
    </View>
  ) : isReady ? (
    <Button label={t('common.close')} variant="primary" fullWidth onPress={onClose} />
  ) : (
    <View style={s.footer}>
      <Button label={t('common.cancel')} variant="secondary" onPress={onClose} disabled={busy} />
      <Button
        label={primaryLabel}
        variant="primary"
        loading={busy}
        disabled={busy}
        onPress={onPrimary}
      />
    </View>
  );

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('registration.personal.scanDni.title')}
      footer={footer}
    >
      <View style={[s.body, { gap: theme.spacing.lg }]}>
        {dniTaken ? null : (
          <Text variant="footnote" color="inkSubtle">
            {t('registration.personal.scanDni.hint')}
          </Text>
        )}

        {/* Preview de las 2 caras. Borde por estado de ENVÍO; en duplicado se atenúan (la captura ya no aplica). */}
        <View style={[s.facesRow, { gap: theme.spacing.md }]}>
          <ScanFacePreview
            label={t('registration.personal.scanDni.front')}
            uri={dni.front?.uri ?? null}
            scanning={isScanning}
            phase={isReady ? facePhases.front : 'idle'}
            dimmed={dniTaken}
          />
          <ScanFacePreview
            label={t('registration.personal.scanDni.back')}
            uri={dni.back?.uri ?? null}
            scanning={isScanning}
            phase={isReady ? facePhases.back : 'idle'}
            dimmed={dniTaken}
          />
        </View>

        {/* DNI DUPLICADO (rojo): el pre-check encontró el DNI en otra cuenta. Bloquea; escanear otro. */}
        {dniTaken ? (
          <View
            style={[
              s.alert,
              {
                backgroundColor: hexAlpha(theme.colors.danger, 0.12),
                borderColor: hexAlpha(theme.colors.danger, 0.4),
                borderRadius: theme.radii.md,
                gap: theme.spacing.sm,
              },
            ]}
          >
            <View style={s.alertHead}>
              <IconAlert size={18} color={theme.colors.danger} strokeWidth={2.2} />
              <Text variant="bodyStrong" style={{ color: theme.colors.danger }}>
                {t('registration.personal.scanDni.dniTakenTitle')}
              </Text>
            </View>
            <Text variant="footnote" color="inkMuted">
              {t('registration.personal.scanDni.dniTakenBody')}
            </Text>
          </View>
        ) : null}

        {/* Bloque "Esto leímos de tu DNI" (frame C/ScanDni): nombre / DNI / nacimiento leídos por OCR. */}
        {!dniTaken && isCaptured && hasReadDniNumber ? (
          <View
            style={[
              s.extract,
              {
                // Bloque recesado gris `$skeleton` (frame `Extracted` #F5F7FA). NO `surfaceElevated`:
                // colapsa a #FFFFFF en light Trust (=== surface del sheet) → sin recess visible.
                backgroundColor: theme.colors.skeleton,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.md,
                gap: theme.spacing.sm,
              },
            ]}
          >
            <Text variant="footnote" color="ink" style={s.extractTitle}>
              {t('registration.personal.scanDni.extracted')}
            </Text>
            <ScanExtractRow
              label={t('registration.personal.scanDni.fieldName')}
              value={dni.personal.fullName}
            />
            <ScanExtractRow
              label={t('registration.personal.scanDni.fieldDni')}
              value={dni.personal.dni}
              mono
            />
            <ScanExtractRow
              label={t('registration.personal.scanDni.fieldBirthdate')}
              value={formatDocumentDate(dni.personal.birthdate)}
              mono
            />
          </View>
        ) : null}

        {/* Estado listo (eager): al confirmar se sube + verifica al instante. */}
        {!dniTaken && isCaptured && hasReadDniNumber ? (
          <ScanStatusLine tone="success" text={t('registration.personal.scanDni.readyEager')} />
        ) : null}

        {/* Verificando (checkDni + PATCH, ANTES de la subida por cara): spinner honesto, no un "listo" mudo. */}
        {isChecking ? (
          <View style={[s.statusRow, { gap: theme.spacing.sm }]}>
            <ActivityIndicator color={theme.colors.accent} />
            <Text variant="footnote" color="accent">
              {t('registration.personal.scanDni.checking')}
            </Text>
          </View>
        ) : null}

        {/* Subiendo: barra indeterminada + nota de segundo plano (la card sigue el progreso al cerrar). */}
        {isSending ? (
          <View style={{ gap: theme.spacing.sm }}>
            <ScanSendingBar />
            <View style={[s.statusRow, { gap: theme.spacing.sm }]}>
              <ActivityIndicator color={theme.colors.accent} />
              <View style={s.statusCol}>
                <Text variant="footnote" color="accent">
                  {t('registration.personal.scanDni.sending')}
                </Text>
                <Text variant="caption" color="inkSubtle">
                  {t('registration.documents.sendingNote')}
                </Text>
              </View>
            </View>
          </View>
        ) : null}

        {isSent ? (
          <ScanStatusLine tone="success" text={t('registration.personal.scanDni.sent')} />
        ) : null}

        {sendFailed ? (
          <Banner
            tone="danger"
            title={t('registration.personal.scanDni.uploadFailed')}
            description={t('registration.personal.scanDni.sendErrorHint')}
          />
        ) : null}

        {/* Fallo del pre-check / PATCH (red o servidor, NO duplicado): honestidad — el conductor ve el error
            y reintenta, en vez de un sheet mudo que no pasó nada. */}
        {submitError ? (
          <Banner
            tone="danger"
            title={t('registration.personal.scanDni.verifyFailedTitle')}
            description={t('registration.personal.scanDni.verifyFailedBody')}
          />
        ) : null}

        {/* Fallback HONESTO del campo crítico: foto capturada pero el OCR NO leyó el número → reescaneo. */}
        {!dniTaken && isCaptured && !hasReadDniNumber ? (
          <Banner
            tone="warn"
            title={t('registration.personal.scanDni.criticalMissingTitle')}
            description={t('registration.personal.scanDni.criticalMissingBody')}
          />
        ) : null}

        {/* Honestidad: solo vino el anverso → avisamos (reescanear para el reverso). */}
        {!dniTaken && isCaptured && hasReadDniNumber && !dni.hasBack ? (
          <Banner
            tone="warn"
            title={t('registration.personal.scanDni.backMissing')}
            description={t('registration.personal.scanDni.backMissingHint')}
          />
        ) : null}

        {/* Degradación honesta: escáner no disponible → tipeo manual. */}
        {dni.unavailable ? (
          <Banner
            tone="warn"
            title={t('registration.documents.scanUnavailable')}
            description={t('registration.personal.scanDni.manualFallback')}
          />
        ) : null}

        {/* Mensaje accionable (cancelación/fallo de escaneo): motivo TIPADO mapeado a i18n. */}
        {dni.message ? (
          <Banner
            tone={isError ? 'danger' : 'warn'}
            title={t('errors.generic')}
            description={t(scanMessageI18nKey(dni.message))}
          />
        ) : null}
      </View>
    </BottomSheet>
  );
}
