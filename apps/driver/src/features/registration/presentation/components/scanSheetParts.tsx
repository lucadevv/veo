import React from 'react';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text, useTheme } from '@veo/ui-kit';
import { IconCheck } from '../../../../shared/presentation/icons';
import { DOCUMENT_CARD_ASPECT_RATIO } from '../../../documents/domain';
import type { DocumentSendPhase } from '../state/registrationStore';
import { hexAlpha } from '../../../../shared/presentation/color';

/**
 * Piezas CANÓNICAS compartidas por los sheets de escaneo EAGER (`ScanDniSheet` y `ScanLicenseSheet`): la
 * preview por cara con su borde de estado, la barra de progreso, la línea de estado, la fila del bloque
 * "Esto leímos" y el formateo de fecha. Un solo componente, CERO copy-paste (regla pencil-to-rn): los dos
 * sheets hablan el MISMO lenguaje visual y una mejora acá los toca a ambos.
 */

/** Línea de estado (tilde + texto) del tono dado. */
export function ScanStatusLine({
  tone,
  text,
}: {
  tone: 'success';
  text: string;
}): React.JSX.Element {
  const theme = useTheme();
  const color = theme.colors[tone];
  return (
    <View style={[scanSheetStyles.statusRow, { gap: theme.spacing.sm }]}>
      <IconCheck size={20} color={color} strokeWidth={2.6} />
      <Text variant="footnote" style={{ color }}>
        {text}
      </Text>
    </View>
  );
}

/** Formatea una fecha/ISO (`AAAA-MM-DD…`) a `DD/MM/AAAA` (toma la parte de fecha). Devuelve el crudo si no parsea. */
export function formatDocumentDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!match) {
    return iso;
  }
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/** Fila etiqueta ↔ valor del bloque "Esto leímos" (valor mono para números/fechas). */
export function ScanExtractRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <View style={scanSheetStyles.extractRow}>
      <Text variant="footnote" color="inkSubtle">
        {label}
      </Text>
      <Text variant="callout" color="ink" style={mono ? scanSheetStyles.monoValue : undefined}>
        {value}
      </Text>
    </View>
  );
}

/** Barra de progreso indeterminada del estado "subiendo" (frames C/ScanDni · C/ScanLicencia). */
export function ScanSendingBar(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[scanSheetStyles.barTrack, { backgroundColor: theme.colors.surfaceElevated }]}>
      <View style={[scanSheetStyles.barFill, { backgroundColor: theme.colors.accent }]} />
    </View>
  );
}

/**
 * Preview de una cara del documento: imagen capturada o placeholder. El borde comunica el estado de ENVÍO
 * por cara (azul=subiendo, verde=enviado, rojo=error); antes de enviar, acento si hay captura. La etiqueta
 * inferior suma el estado ("Anverso · Enviado") cuando la subida está en curso. Reusa los mismos textos de
 * `registration.documents.state.*` en ambos sheets.
 */
export function ScanFacePreview({
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
    <View style={[scanSheetStyles.faceCol, dimmed ? scanSheetStyles.dimmed : undefined]}>
      <View
        style={[
          scanSheetStyles.facePreview,
          {
            backgroundColor: theme.colors.surfaceElevated,
            borderColor,
            borderRadius: theme.radii.md,
          },
        ]}
      >
        {uri ? (
          <Image source={{ uri }} style={scanSheetStyles.faceImage} resizeMode="contain" />
        ) : (
          <View style={scanSheetStyles.faceEmpty}>
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

/** Estilos compartidos por los sheets de escaneo (layout + piezas). */
export const scanSheetStyles = StyleSheet.create({
  body: { paddingBottom: 8 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  facesRow: { flexDirection: 'row' },
  faceCol: { flex: 1, gap: 6 },
  dimmed: { opacity: 0.5 },
  // Proporción de tarjeta ID-1: el documento escaneado llena el contenedor SIN recorte (adiós zoom).
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
  // Bloque de extracción OCR ("Esto leímos de tu …").
  extract: { borderWidth: 1, padding: 14 },
  extractTitle: { fontWeight: '600' },
  extractRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  monoValue: { fontFamily: 'Menlo', letterSpacing: 0.5 },
  // Alerta destacada (DNI duplicado / aviso).
  alert: { borderWidth: 1, padding: 14 },
  alertHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Barra de progreso indeterminada del "subiendo".
  barTrack: { height: 4, borderRadius: 999, overflow: 'hidden', width: '100%' },
  barFill: { height: 4, width: '45%', borderRadius: 999 },
});
