import React, {type ReactNode} from 'react';
import {ActivityIndicator, Pressable, StyleSheet, View} from 'react-native';
import Svg, {Circle, Path} from 'react-native-svg';
import {Text, useTheme} from '@veo/ui-kit';
import {hexAlpha} from './color';
import {IconAlert, IconCheck} from '../../../../shared/presentation/icons';
import type {DocumentUploadStatus} from '../../domain';

/** Tono semántico del chip de estado del documento. */
export type DocumentCardTone = 'success' | 'warn' | 'danger' | 'neutral' | 'accent';

/** Estado del servidor a reflejar en el chip (etiqueta ya localizada + tono). */
export interface DocumentServerState {
  label: string;
  tone: DocumentCardTone;
}

/** Glifo de cámara (chip "Pendiente"). Inline para no depender del set global. */
function CameraGlyph({color, size = 14}: {color: string; size?: number}): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 8a2 2 0 0 1 2-2h1.5l1-1.5h5L16 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={13} r={3} stroke={color} strokeWidth={2} />
    </Svg>
  );
}

interface StatusChipProps {
  status: DocumentUploadStatus;
  uploadedLabel: string;
  pendingLabel: string;
  /** Estado real del servidor (tiene prioridad sobre el local uploaded/pending). */
  serverState?: DocumentServerState;
}

/** Resuelve el color del tono usando tokens del tema. */
function toneColor(tone: DocumentCardTone, theme: ReturnType<typeof useTheme>): string {
  switch (tone) {
    case 'success':
      return theme.colors.success;
    case 'warn':
      return theme.colors.warn;
    case 'danger':
      return theme.colors.danger;
    case 'neutral':
      return theme.colors.inkMuted;
    case 'accent':
    default:
      return theme.colors.accent;
  }
}

/**
 * Chip de estado del documento. Si hay estado del servidor (`serverState`), refleja el `simpleStatus`
 * real (vigente/por_vencer/vencido/en_revision/rechazado) con su tono; si no, usa el estado local
 * (Subido/Pendiente) del avance del wizard.
 */
function StatusChip({status, uploadedLabel, pendingLabel, serverState}: StatusChipProps): React.JSX.Element {
  const theme = useTheme();

  if (serverState) {
    const tint = toneColor(serverState.tone, theme);
    return (
      <View
        style={[
          styles.chip,
          styles.chipBordered,
          {
            backgroundColor: hexAlpha(tint, 0.16),
            borderColor: hexAlpha(tint, 0.55),
            borderRadius: theme.radii.pill,
            gap: theme.spacing.xs,
          },
        ]}>
        <StatusGlyph tone={serverState.tone} color={tint} />
        <Text variant="caption" style={{color: tint}}>
          {serverState.label}
        </Text>
      </View>
    );
  }

  const uploaded = status === 'uploaded';
  const tint = uploaded ? theme.colors.success : theme.colors.accent;
  return (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: hexAlpha(tint, 0.16),
          borderColor: uploaded ? 'transparent' : hexAlpha(tint, 0.55),
          borderWidth: uploaded ? 0 : 1,
          borderRadius: theme.radii.pill,
          gap: theme.spacing.xs,
        },
      ]}>
      {uploaded ? (
        <IconCheck size={14} color={tint} strokeWidth={2.6} />
      ) : (
        <CameraGlyph color={tint} />
      )}
      <Text variant="caption" color={uploaded ? 'success' : 'accent'}>
        {uploaded ? uploadedLabel : pendingLabel}
      </Text>
    </View>
  );
}

/** Glifo del chip según el tono del estado del servidor. */
function StatusGlyph({tone, color}: {tone: DocumentCardTone; color: string}): React.JSX.Element {
  if (tone === 'success') {
    return <IconCheck size={14} color={color} strokeWidth={2.6} />;
  }
  if (tone === 'warn' || tone === 'danger') {
    return <IconAlert size={14} color={color} strokeWidth={2.2} />;
  }
  return <CameraGlyph color={color} />;
}

interface DocumentUploadCardProps {
  icon: ReactNode;
  label: string;
  status: DocumentUploadStatus;
  uploadedLabel: string;
  pendingLabel: string;
  accessibilityLabel: string;
  onPress: () => void;
  /** Estado real del servidor a reflejar en el chip (rehidratado de `GET /drivers/me/documents`). */
  serverState?: DocumentServerState;
  /** Muestra un spinner en el chip mientras se registra/refresca el documento. */
  busy?: boolean;
}

/**
 * Tarjeta de documento del alta: ícono + nombre + chip de estado. Presionable para registrar el
 * documento contra el endpoint real del driver-bff (vía `HttpRegistrationRepository` por DI); el
 * documento queda en revisión y el backend decide su estado final. Área táctil amplia y feedback de
 * press del `Pressable`.
 */
export function DocumentUploadCard({
  icon,
  label,
  status,
  uploadedLabel,
  pendingLabel,
  accessibilityLabel,
  onPress,
  serverState,
  busy = false,
}: DocumentUploadCardProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{busy}}
      disabled={busy}
      onPress={onPress}
      style={({pressed}) => [
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.lg,
          gap: theme.spacing.md,
          opacity: pressed || busy ? 0.9 : 1,
        },
      ]}>
      <View
        style={[
          styles.iconBox,
          {backgroundColor: hexAlpha(theme.colors.accent, 0.14), borderRadius: theme.radii.md},
        ]}>
        {icon}
      </View>
      <Text variant="bodyStrong" style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {busy ? (
        <ActivityIndicator color={theme.colors.accent} />
      ) : (
        <StatusChip
          status={status}
          uploadedLabel={uploadedLabel}
          pendingLabel={pendingLabel}
          serverState={serverState}
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {flexDirection: 'row', alignItems: 'center', borderWidth: 1, alignSelf: 'stretch'},
  iconBox: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  label: {flex: 1},
  chip: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5},
  chipBordered: {borderWidth: 1},
});
