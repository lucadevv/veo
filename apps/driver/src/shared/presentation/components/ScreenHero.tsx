import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '@veo/ui-kit';
import { Reveal } from './motion';

interface ScreenHeroProps {
  /** Título editorial `display` alineado a la IZQUIERDA (estándar del registro / Tesla). */
  title: string;
  /** Subtítulo `callout` muted bajo el título (contexto de la pantalla). */
  subtitle?: string;
  /** Versalita opcional SOBRE el título (sección) — p. ej. "GANANCIAS". Usa la variante `label`. */
  eyebrow?: string;
  /** Elemento al costado derecho del título (pill de estado, monto, acción). Alineado a la base. */
  trailing?: React.ReactNode;
}

/**
 * Cabecera editorial CANÓNICA de las pantallas operativas del conductor. Hereda el lenguaje del REGISTRO
 * (la única superficie con buen gusto probado): título `display` a la izquierda con aire generoso, subtítulo
 * `callout` muted, entrada con `Reveal`. Reemplaza los `title1/2/3` genéricos —algunos centrados— que hacían
 * sentir las pantallas "hechas por AI". No mete el wordmark en cada pantalla (eso sería logo-spam): la marca
 * vive en la tipografía. El escalonado del resto del contenido se hace con `Reveal delay={40/80/120…}`.
 */
export function ScreenHero({ title, subtitle, eyebrow, trailing }: ScreenHeroProps): React.JSX.Element {
  return (
    <Reveal style={styles.hero}>
      {eyebrow ? (
        <Text variant="label" color="accent">
          {eyebrow}
        </Text>
      ) : null}
      <View style={styles.titleRow}>
        <Text variant="display" style={styles.title}>
          {title}
        </Text>
        {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      </View>
      {subtitle ? (
        <Text variant="callout" color="inkMuted">
          {subtitle}
        </Text>
      ) : null}
    </Reveal>
  );
}

const styles = StyleSheet.create({
  hero: { gap: 8, marginTop: 4, marginBottom: 16 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: { flexShrink: 1 },
  trailing: { paddingBottom: 6 },
});
