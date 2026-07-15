import React, { useState } from 'react';
import { LayoutAnimation, Platform, Pressable, StyleSheet, UIManager, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text, useReducedMotion, useTheme } from '@veo/ui-kit';
import {
  IconCar,
  IconChevronRight,
  IconCoins,
  IconFace,
  IconPower,
  type IconProps,
} from '../../../../shared/presentation/icons';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * "Temas frecuentes" del conductor (frame `C/Ayuda`): cada tema es una fila-card con su tile de icono
 * + título + chevron, y al tocarla despliega la respuesta inline (una abierta a la vez). Filtrable por
 * el buscador de la pantalla (client-side sobre pregunta + respuesta). El orden espeja el frame.
 */
const TOPICS: { key: string; icon: (props: IconProps) => React.JSX.Element }[] = [
  { key: 'payouts', icon: IconCoins },
  { key: 'faceVerification', icon: IconFace },
  { key: 'vehicle', icon: IconCar },
  { key: 'shiftStart', icon: IconPower },
];

export interface FaqTopicsProps {
  /** Filtro de texto (client-side) sobre pregunta + respuesta. Vacío = todos. */
  query?: string;
}

/** Devuelve los temas que matchean el filtro (para que el parent sepa si mostrar el empty). */
export function filterFaqTopics(query: string, t: (k: string) => string): typeof TOPICS {
  const q = query.trim().toLowerCase();
  if (!q) {
    return TOPICS;
  }
  return TOPICS.filter((topic) => {
    const text = `${t(`support.faq.${topic.key}.q`)} ${t(`support.faq.${topic.key}.a`)}`.toLowerCase();
    return text.includes(q);
  });
}

export function FaqTopics({ query = '' }: FaqTopicsProps): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const [openKey, setOpenKey] = useState<string | null>(null);

  const topics = filterFaqTopics(query, t);

  const toggle = (key: string) => {
    if (!reduceMotion) {
      LayoutAnimation.configureNext({
        duration: 200,
        update: { type: LayoutAnimation.Types.easeInEaseOut },
        create: {
          type: LayoutAnimation.Types.easeInEaseOut,
          property: LayoutAnimation.Properties.opacity,
        },
        delete: {
          type: LayoutAnimation.Types.easeInEaseOut,
          property: LayoutAnimation.Properties.opacity,
        },
      });
    }
    setOpenKey((prev) => (prev === key ? null : key));
  };

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {topics.map(({ key, icon: Glyph }) => {
        const open = openKey === key;
        return (
          <Pressable
            key={key}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => toggle(key)}
            style={({ pressed }) => [
              styles.card,
              {
                backgroundColor: theme.colors.surface,
                borderColor: open ? theme.colors.borderStrong : theme.colors.border,
                borderRadius: theme.radii.lg,
                padding: theme.spacing.lg,
                opacity: pressed ? 0.9 : 1,
              },
            ]}
          >
            <View style={styles.row}>
              <View
                style={[
                  styles.iconTile,
                  { backgroundColor: theme.colors.skeleton, borderRadius: theme.radii.md },
                ]}
              >
                <Glyph size={20} color={theme.colors.ink} />
              </View>
              <Text variant="bodyStrong" style={styles.flex} numberOfLines={open ? undefined : 2}>
                {t(`support.faq.${key}.q`)}
              </Text>
              <View style={open ? styles.chevronOpen : undefined}>
                <IconChevronRight size={20} color={theme.colors.inkSubtle} />
              </View>
            </View>
            {open ? (
              <Text variant="footnote" color="inkMuted" style={styles.answer}>
                {t(`support.faq.${key}.a`)}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
  iconTile: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  chevronOpen: { transform: [{ rotate: '90deg' }] },
  answer: { marginTop: 12 },
});
