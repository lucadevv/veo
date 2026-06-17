import React, { useState } from 'react';
import { LayoutAnimation, Platform, Pressable, StyleSheet, UIManager, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text, useReducedMotion, useTheme } from '@veo/ui-kit';
import { IconChevronRight } from '../../../../shared/presentation/icons';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** Claves i18n de las preguntas frecuentes del conductor (pregunta + respuesta). */
export const FAQ_KEYS = ['shiftStart', 'payouts', 'documents', 'incentives', 'safety'] as const;
export type FaqKey = (typeof FAQ_KEYS)[number];

/**
 * Acordeón de preguntas frecuentes del conductor (FAQ estático). Una sola abierta a la vez para no
 * abrumar; despliegue con `LayoutAnimation` (ease-out corto) que se degrada a instantáneo con
 * reduce-motion. Texto legible en poca luz y áreas táctiles cómodas.
 */
export function FaqAccordion(): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const [openKey, setOpenKey] = useState<FaqKey | null>(null);

  const toggle = (key: FaqKey) => {
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
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
        },
      ]}
    >
      {FAQ_KEYS.map((key, index) => {
        const open = openKey === key;
        return (
          <View
            key={key}
            style={
              index > 0
                ? { borderTopColor: theme.colors.border, borderTopWidth: StyleSheet.hairlineWidth }
                : undefined
            }
          >
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              onPress={() => toggle(key)}
              style={({ pressed }) => [
                styles.row,
                {
                  paddingHorizontal: theme.spacing.lg,
                  paddingVertical: theme.spacing.lg,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Text variant="callout" style={styles.flex}>
                {t(`support.faq.${key}.q`)}
              </Text>
              <View style={[styles.chevron, open && styles.chevronOpen]}>
                <IconChevronRight size={18} color={theme.colors.inkSubtle} />
              </View>
            </Pressable>
            {open ? (
              <View
                style={[
                  styles.answer,
                  { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg },
                ]}
              >
                <Text variant="footnote" color="inkMuted">
                  {t(`support.faq.${key}.a`)}
                </Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1 },
  chevron: { transform: [{ rotate: '90deg' }] },
  chevronOpen: { transform: [{ rotate: '270deg' }] },
  answer: {},
});
