import React, { type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';
import { hexAlpha } from './color';
import { IconAlert, IconCamera, IconCheck } from '../../../../shared/presentation/icons';
import type { DocumentUploadStatus } from '../../domain';

/** Tono semántico del chip de estado del documento. */
export type DocumentCardTone = 'success' | 'warn' | 'danger' | 'neutral' | 'accent';

/** Estado del servidor a reflejar en el chip (etiqueta ya localizada + tono). */
export interface DocumentServerState {
  label: string;
  tone: DocumentCardTone;
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
function StatusChip({
  status,
  uploadedLabel,
  pendingLabel,
  serverState,
}: StatusChipProps): React.JSX.Element {
  const theme = useTheme();

  if (serverState) {
    const tint = toneColor(serverState.tone, theme);
    // Aplanado: tinte de fondo suave + texto del color semántico + iconito. SIN borde — el color del
    // tono ya comunica el estado; el borde solo agregaba ruido (una caja más).
    return (
      <View
        style={[
          styles.chip,
          {
            backgroundColor: hexAlpha(tint, 0.16),
            borderRadius: theme.radii.pill,
            gap: theme.spacing.xs,
          },
        ]}
      >
        <StatusGlyph tone={serverState.tone} color={tint} />
        <Text variant="caption" style={{ color: tint }}>
          {serverState.label}
        </Text>
      </View>
    );
  }

  // Estado LOCAL "uploaded" = capturado en el dispositivo, PENDIENTE de subir ("Listo para enviar"). NO es
  // "Verificado": el tono honesto es ámbar (warn), no verde. El verde (success) solo lo pinta el chip de
  // SERVIDOR (`serverState`) cuando el doc ya está realmente aprobado. Antes pintaba verde + check y decía
  // "Subido" antes de subir: mentía. Ahora el check ámbar comunica "listo, falta enviarlo".
  const captured = status === 'uploaded';
  const tint = captured ? theme.colors.warn : theme.colors.accent;
  return (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: hexAlpha(tint, 0.16),
          borderRadius: theme.radii.pill,
          gap: theme.spacing.xs,
        },
      ]}
    >
      {captured ? (
        <IconCheck size={14} color={tint} strokeWidth={2.6} />
      ) : (
        <IconCamera size={14} color={tint} strokeWidth={2} />
      )}
      <Text variant="caption" style={{ color: tint }}>
        {captured ? uploadedLabel : pendingLabel}
      </Text>
    </View>
  );
}

/** Glifo del chip según el tono del estado del servidor. */
function StatusGlyph({
  tone,
  color,
}: {
  tone: DocumentCardTone;
  color: string;
}): React.JSX.Element {
  if (tone === 'success') {
    return <IconCheck size={14} color={color} strokeWidth={2.6} />;
  }
  if (tone === 'warn' || tone === 'danger') {
    return <IconAlert size={14} color={color} strokeWidth={2.2} />;
  }
  return <IconCamera size={14} color={color} strokeWidth={2} />;
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
  /**
   * Número de PASO de la secuencia de captura (U3 · jerarquía 1-2-3). Cuando se provee, la card pinta un
   * badge "N" antes del ícono para comunicar el ORDEN ("primero 1, después 2…"). Reemplaza el ícono-glifo
   * como ancla visual: así DNI/licencia/tarjeta/foto/SOAT comparten UN patrón de card numerada y el ojo
   * sabe la secuencia. Sin número (`undefined`) la card mantiene su look clásico (solo ícono).
   */
  stepNumber?: number;
}

/**
 * Badge numérico del paso (U3): círculo SUTIL lleno con el número de orden — sin borde (una caja menos).
 * El relleno tenue (accent al 12%) y el número en accent comunican "paso N" sin encajonar. Tokens del
 * tema, sin hex suelto. CONSERVA el `value` (los tests de jerarquía U3 dependen de que el número exista).
 */
function StepBadge({ value }: { value: number }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.stepBadge,
        {
          backgroundColor: hexAlpha(theme.colors.accent, 0.12),
          borderRadius: theme.radii.pill,
        },
      ]}
    >
      <Text variant="caption" color="accent">
        {String(value)}
      </Text>
    </View>
  );
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
  stepNumber,
}: DocumentUploadCardProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          // Card aplanada: un pelo elevada del fondo (`surface`), SIN borde. Más aire vertical. La
          // jerarquía la dan el aire + la escala, no cajas anidadas.
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.lg,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.xl,
          gap: theme.spacing.md,
          opacity: pressed || busy ? 0.9 : 1,
        },
      ]}
    >
      {stepNumber !== undefined ? <StepBadge value={stepNumber} /> : null}
      {/* Ícono PLANO inline: sin caja ni fondo tintado. Sobrio, deja respirar la fila. */}
      <View style={styles.icon}>{icon}</View>
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
  // Sin `borderWidth`: la card es plana, separada del fondo solo por su `surface`.
  card: { flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' },
  // Sin `borderWidth`: círculo lleno sutil.
  stepBadge: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Ícono inline (sin caja 44×44): solo centra el glifo en un ancho fijo para alinear las filas.
  icon: { width: 28, alignItems: 'center', justifyContent: 'center' },
  label: { flex: 1 },
  chip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5 },
});
