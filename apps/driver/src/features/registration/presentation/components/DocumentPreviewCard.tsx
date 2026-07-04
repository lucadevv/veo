import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@veo/ui-kit';
import { IconCheck } from '../../../../shared/presentation/icons';
import { DOCUMENT_CARD_ASPECT_RATIO } from '../../../documents/domain';
import { hexAlpha } from './color';

/**
 * Preview CANÓNICO de un documento capurado (DNI / licencia). Estética "Tesla" (negro premium): la IMAGEN
 * del documento es el HÉROE (a sangre, esquinas redondeadas por el `overflow` de la card), y el éxito es un
 * ACENTO MÍNIMO — un check chico en una píldora sutil + una línea de estado — NO un recuadro verde (ese es el
 * look "success card de AI"). Un solo componente para AMBOS documentos: misma jerarquía, cero copy-paste.
 *
 * Honestidad de estado: el caption lo decide el llamador. La captura es LOCAL (la subida se difiere al
 * "Continuar"), así que el texto correcto es "listo para enviar", nunca "subido".
 */
export interface DocumentPreviewCardProps {
  /** URI local de la imagen capturada (anverso del DNI / foto de la licencia). */
  imageUri: string;
  /** Nombre del documento (p. ej. "DNI", "Licencia de conducir"). */
  title: string;
  /** Línea de estado bajo el título (p. ej. "Listo para enviar"). HONESTA: no afirma subida. */
  caption: string;
}

export function DocumentPreviewCard({
  imageUri,
  title,
  caption,
}: DocumentPreviewCardProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${title}. ${caption}`}
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          ...theme.elevation.level2,
        },
      ]}
    >
      <Image
        source={{ uri: imageUri }}
        style={styles.image}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />
      <View
        style={[
          styles.statusBar,
          {
            borderTopColor: theme.colors.border,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            gap: theme.spacing.md,
          },
        ]}
      >
        <View
          style={[styles.badge, { backgroundColor: hexAlpha(theme.colors.success, 0.14) }]}
        >
          <IconCheck size={15} color={theme.colors.success} strokeWidth={2.6} />
        </View>
        <View style={styles.statusText}>
          <Text variant="headline" color="ink">
            {title}
          </Text>
          <Text variant="footnote" color="inkMuted">
            {caption}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // `overflow: hidden` recorta la imagen a sangre contra el radio de la card (esquinas superiores limpias).
  card: { borderWidth: 1, overflow: 'hidden' },
  // Proporción de tarjeta ID-1 (DNI/licencia): el documento se ve ENTERO, sin el zoom del cover.
  image: { width: '100%', aspectRatio: DOCUMENT_CARD_ASPECT_RATIO },
  // Hairline que separa la imagen-héroe de la línea de estado, sin un divisor pesado.
  statusBar: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth },
  badge: { width: 28, height: 28, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  statusText: { flex: 1, gap: 2 },
});
