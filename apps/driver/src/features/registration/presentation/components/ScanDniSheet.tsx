import React, { useEffect } from 'react';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner, BottomSheet, Button, Text, useTheme } from '@veo/ui-kit';
import { IconAlert, IconCheck } from '../../../../shared/presentation/icons';
import { DOCUMENT_CARD_ASPECT_RATIO, scanMessageI18nKey } from '../../../documents/domain';
import {
  deriveDocumentPhase,
  type DocumentFacePhases,
  type DocumentSendPhase,
} from '../state/registrationStore';
import { hexAlpha } from './color';
import { useScanDni } from '../hooks/useScanDni';

/**
 * Sheet de captura del DNI por ESCANEO (paso 1 · flujo EAGER a imagen del frame `C/ScanDni` del pen):
 * escanea anverso + reverso, corre el OCR del frente, muestra lo LEÍDO (nombre/DNI/nacimiento) y, al
 * confirmar, dispara la subida INMEDIATA con estados POR CARA (subiendo azul → enviado verde / error rojo)
 * y el bloqueo rojo si el DNI YA está registrado en otra cuenta (`dniTaken`, del pre-check `check-dni`).
 *
 * Estados HONESTOS (vía `useScanDni` + las fases por-cara del store): nunca se marca un éxito que no
 * ocurrió. Degradación honesta: escáner no disponible → tipeo manual; reverso ausente se avisa; el OCR
 * sin número crítico cae a reescaneo. Reusa por DI el escáner + el parser + el pipeline de subida.
 */
export interface ScanDniSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Fases de envío POR CARA del DNI (del store). El sheet pinta cada preview: azul=subiendo, verde=enviado, rojo=error. */
  facePhases: DocumentFacePhases;
  /** El DNI escaneado YA pertenece a otra cuenta (pre-check `check-dni`). Pinta el estado rojo de bloqueo. */
  dniTaken: boolean;
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
  onConfirm,
  onRescan,
}: ScanDniSheetProps): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  const dni = useScanDni();

  // Limpia el flujo cada vez que el sheet se abre (captura fresca, sin arrastrar un escaneo previo).
  useEffect(() => {
    if (visible) {
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

  // Campo CRÍTICO del DNI: el número. Sin él (OCR borroso/ausente) NO fingimos "capturado": reescaneo.
  const hasReadDniNumber = dni.personal.dni.trim().length > 0;
  // ¿Ya se leyeron los 3 campos del bloque "Esto leímos"? (nombre + número + nacimiento).
  const hasFullExtract =
    dni.personal.fullName.trim().length > 0 &&
    hasReadDniNumber &&
    dni.personal.birthdate.trim().length > 0;

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
  ) : isSending ? (
    // Subiendo: no te toma de rehén — "Continuar en segundo plano" cierra; la card sigue el progreso.
    <Button
      label={t('registration.documents.sheetBackground')}
      variant="secondary"
      fullWidth
      onPress={onClose}
    />
  ) : sendFailed ? (
    <View style={styles.footer}>
      <Button label={t('common.close')} variant="secondary" onPress={onClose} />
      <Button
        label={t('registration.actions.retryUpload')}
        variant="primary"
        onPress={onConfirm}
      />
    </View>
  ) : isReady ? (
    <Button label={t('common.close')} variant="primary" fullWidth onPress={onClose} />
  ) : (
    <View style={styles.footer}>
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
      <View style={[styles.body, { gap: theme.spacing.lg }]}>
        {dniTaken ? null : (
          <Text variant="footnote" color="inkSubtle">
            {t('registration.personal.scanDni.hint')}
          </Text>
        )}

        {/* Preview de las 2 caras. Borde por estado de ENVÍO (azul=subiendo, verde=enviado, rojo=error);
            antes de enviar, acento si hay captura. En duplicado se atenúan (la captura ya no aplica). */}
        <View style={[styles.facesRow, { gap: theme.spacing.md }]}>
          <FacePreview
            label={t('registration.personal.scanDni.front')}
            uri={dni.front?.uri ?? null}
            scanning={isScanning}
            phase={isReady ? facePhases.front : 'idle'}
            dimmed={dniTaken}
          />
          <FacePreview
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
              styles.redAlert,
              {
                backgroundColor: hexAlpha(theme.colors.danger, 0.12),
                borderColor: hexAlpha(theme.colors.danger, 0.4),
                borderRadius: theme.radii.md,
                gap: theme.spacing.sm,
              },
            ]}
          >
            <View style={styles.redHead}>
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

        {/* Bloque "Esto leímos de tu DNI" (frame C/ScanDni): nombre / DNI / nacimiento leídos por OCR.
            Solo antes de enviar, cuando la captura leyó el número crítico. */}
        {!dniTaken && isCaptured && hasReadDniNumber ? (
          <ExtractBlock
            fullName={dni.personal.fullName}
            dniNumber={dni.personal.dni}
            birthdate={dni.personal.birthdate}
          />
        ) : null}

        {/* Estado listo (eager): al confirmar se sube + verifica al instante. */}
        {!dniTaken && isCaptured && hasReadDniNumber ? (
          <StatusLine tone="success" text={t('registration.personal.scanDni.readyEager')} />
        ) : null}

        {/* Subiendo: barra indeterminada + nota de segundo plano (la card sigue el progreso al cerrar). */}
        {isSending ? (
          <View style={{ gap: theme.spacing.sm }}>
            <SendingBar />
            <View style={[styles.statusRow, { gap: theme.spacing.sm }]}>
              <ActivityIndicator color={theme.colors.accent} />
              <View style={styles.statusCol}>
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
          <StatusLine tone="success" text={t('registration.personal.scanDni.sent')} />
        ) : null}

        {sendFailed ? (
          <Banner
            tone="danger"
            title={t('registration.personal.scanDni.uploadFailed')}
            description={t('registration.personal.scanDni.sendErrorHint')}
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

/** Línea de estado (tilde + texto) del tono dado. */
function StatusLine({ tone, text }: { tone: 'success'; text: string }): React.JSX.Element {
  const theme = useTheme();
  const color = theme.colors[tone];
  return (
    <View style={[styles.statusRow, { gap: theme.spacing.sm }]}>
      <IconCheck size={20} color={color} strokeWidth={2.6} />
      <Text variant="footnote" style={{ color }}>
        {text}
      </Text>
    </View>
  );
}

/** Formatea una fecha ISO `AAAA-MM-DD` a `DD/MM/AAAA` (como el frame). Devuelve el crudo si no parsea. */
function formatBirthdate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) {
    return iso;
  }
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/** Bloque "Esto leímos de tu DNI": lo que el OCR extrajo, read-only (nombre / DNI / nacimiento). */
function ExtractBlock({
  fullName,
  dniNumber,
  birthdate,
}: {
  fullName: string;
  dniNumber: string;
  birthdate: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View
      style={[
        styles.extract,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
          gap: theme.spacing.sm,
        },
      ]}
    >
      <Text variant="footnote" color="ink" style={styles.extractTitle}>
        {t('registration.personal.scanDni.extracted')}
      </Text>
      <ExtractRow label={t('registration.personal.scanDni.fieldName')} value={fullName} />
      <ExtractRow label={t('registration.personal.scanDni.fieldDni')} value={dniNumber} mono />
      <ExtractRow
        label={t('registration.personal.scanDni.fieldBirthdate')}
        value={formatBirthdate(birthdate)}
        mono
      />
    </View>
  );
}

/** Fila etiqueta ↔ valor del bloque de extracción (valor mono para DNI/nacimiento, como el frame). */
function ExtractRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.extractRow}>
      <Text variant="footnote" color="inkSubtle">
        {label}
      </Text>
      <Text variant="callout" color="ink" style={mono ? styles.monoValue : undefined}>
        {value}
      </Text>
    </View>
  );
}

/** Barra de progreso indeterminada (sweep) para el estado "subiendo" (como el frame C/ScanLicencia). */
function SendingBar(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.barTrack, { backgroundColor: theme.colors.surfaceElevated }]}>
      <View style={[styles.barFill, { backgroundColor: theme.colors.accent }]} />
    </View>
  );
}

/**
 * Preview de una cara del DNI: imagen capturada o placeholder. El borde comunica el estado de ENVÍO por
 * cara (azul=subiendo, verde=enviado, rojo=error); antes de enviar, acento si hay captura. La etiqueta
 * inferior suma el estado ("Anverso · Enviado") cuando la subida está en curso.
 */
function FacePreview({
  label,
  uri,
  scanning,
  phase,
  dimmed,
}: {
  label: string;
  uri: string | null;
  scanning: boolean;
  phase: DocumentSendPhase;
  dimmed: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  const phaseColor =
    phase === 'sent'
      ? theme.colors.success
      : phase === 'sending'
        ? theme.colors.accent
        : phase === 'error'
          ? theme.colors.danger
          : null;
  const borderColor = phaseColor
    ? hexAlpha(phaseColor, 0.5)
    : uri
      ? hexAlpha(theme.colors.accent, 0.5)
      : theme.colors.border;
  const stateLabel =
    phase === 'sent'
      ? t('registration.documents.state.sent')
      : phase === 'sending'
        ? t('registration.documents.state.sending')
        : phase === 'error'
          ? t('registration.documents.state.sendError')
          : null;

  return (
    <View style={[styles.faceCol, dimmed ? styles.dimmed : undefined]}>
      <View
        style={[
          styles.facePreview,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderColor,
            borderRadius: theme.radii.md,
          },
        ]}
      >
        {uri ? (
          <Image source={{ uri }} style={styles.faceImage} resizeMode="contain" />
        ) : (
          <View style={styles.faceEmpty}>
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
      <Text variant="caption" color={stateLabel ? undefined : 'inkSubtle'} align="center">
        {stateLabel ? `${label} · ${stateLabel}` : label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: 8 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  facesRow: { flexDirection: 'row' },
  faceCol: { flex: 1, gap: 6 },
  dimmed: { opacity: 0.5 },
  // Proporción de tarjeta ID-1: el DNI escaneado llena el contenedor SIN recorte (adiós zoom).
  facePreview: {
    aspectRatio: DOCUMENT_CARD_ASPECT_RATIO,
    borderWidth: 1,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  faceImage: { width: '100%', height: '100%' },
  faceEmpty: { alignItems: 'center', justifyContent: 'center', flex: 1 },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusCol: { flex: 1, gap: 2 },
  // Bloque de extracción OCR (nombre/DNI/nacimiento).
  extract: { borderWidth: 1, padding: 14 },
  extractTitle: { fontWeight: '600' },
  extractRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  monoValue: { fontFamily: 'Menlo', letterSpacing: 0.5 },
  // Alerta roja del DNI duplicado.
  redAlert: { borderWidth: 1, padding: 14 },
  redHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Barra de progreso indeterminada del "subiendo".
  barTrack: { height: 4, borderRadius: 999, overflow: 'hidden', width: '100%' },
  barFill: { height: 4, width: '45%', borderRadius: 999 },
});
