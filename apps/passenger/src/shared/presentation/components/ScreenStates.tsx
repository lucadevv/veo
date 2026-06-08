import { Banner, Button, Skeleton, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

/**
 * Estados transversales (carga / error / vacío) construidos con `@veo/ui-kit`. Toda vista con
 * datos remotos debe cubrir los tres (checklist DESIGN-MOBILE §8). Sin colores hardcodeados.
 */

/** Bloque de carga con skeletons (reserva espacio, anti-CLS). */
export function LoadingState({ lines = 3 }: { lines?: number }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.container, { gap: theme.spacing.md }]} accessibilityLabel="Cargando">
      <Skeleton height={28} width="60%" />
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton key={index} height={56} radius={theme.radii.md} />
      ))}
    </View>
  );
}

/** Estado de error con reintento opcional. */
export function ErrorState({
  message,
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  return (
    <View style={[styles.container, { gap: theme.spacing.md }]}>
      <Banner tone="danger" title={t('states.errorTitle')} description={message ?? t('states.errorBody')} />
      {onRetry ? <Button label={t('actions.retry')} variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

/** Estado vacío centrado con título y subtítulo. */
export function EmptyState({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.centered, { gap: theme.spacing.sm, padding: theme.spacing['3xl'] }]}>
      <Text variant="title3" align="center">
        {title}
      </Text>
      {subtitle ? (
        <Text variant="callout" color="inkMuted" align="center">
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
