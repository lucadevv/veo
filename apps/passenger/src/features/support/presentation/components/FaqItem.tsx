import { Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import {
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  UIManager,
  View,
} from 'react-native';

// Habilita LayoutAnimation en Android (no-op en iOS). Llamada una sola vez al cargar el módulo.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export interface FaqItemProps {
  question: string;
  answer: string;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Fila de acordeón para la FAQ. Una sola pregunta abierta a la vez (lo controla el padre).
 * Transición de altura sutil con LayoutAnimation (sin librería extra) y chevron que rota.
 * El color nunca es el único indicador: el chevron y el peso del texto marcan el estado abierto.
 */
export function FaqItem({ question, answer, expanded, onToggle }: FaqItemProps): React.JSX.Element {
  const theme = useTheme();

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.create(160, 'easeInEaseOut', 'opacity'));
    onToggle();
  };

  return (
    <View style={[styles.wrapper, { borderBottomColor: theme.colors.border }]}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={question}
        style={({ pressed }) => [
          styles.header,
          { paddingVertical: theme.spacing.lg },
          pressed ? { opacity: 0.6 } : null,
        ]}
      >
        <View style={styles.questionText}>
          <Text variant="callout" color={expanded ? 'ink' : 'inkMuted'}>
            {question}
          </Text>
        </View>
        <Text
          variant="callout"
          color={expanded ? 'accent' : 'inkSubtle'}
          style={[styles.chevron, expanded ? styles.chevronOpen : null]}
        >
          ⌄
        </Text>
      </Pressable>

      {expanded ? (
        <View style={{ paddingBottom: theme.spacing.lg }}>
          <Text variant="footnote" color="inkMuted">
            {answer}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { borderBottomWidth: StyleSheet.hairlineWidth },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  questionText: { flex: 1 },
  chevron: { transform: [{ rotate: '0deg' }] },
  chevronOpen: { transform: [{ rotate: '180deg' }] },
});
