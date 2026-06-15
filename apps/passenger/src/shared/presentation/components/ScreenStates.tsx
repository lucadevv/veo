import { Banner, Button, SafeScreen, Skeleton, Text, useTheme } from '@veo/ui-kit';
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

/**
 * Fallback de pantalla para los estados NO-éxito de una vista con datos remotos: pinta carga o error
 * sobre un `<SafeScreen>` pelado. Se RETORNA desde el early-return del guard, NO envuelve el contenido:
 * así cada pantalla conserva sus guards inline (`if (q.isLoading) return …`) y con ellos el narrowing
 * de TS sobre `query.data` y sobre cualquier estado local — un wrapper de children los perdería y forzaría
 * `data!` (rompe "no any/narrowing"). Su valor es matar el clon estructural del trío `<SafeScreen><LoadingState/></SafeScreen>`
 * repetido pantalla a pantalla, dejándolo en UNA definición. `loading` decide el modo; sin él, es el estado de error.
 */
export function ScreenStateFallback({
  loading = false,
  loadingLines,
  errorMessage,
  onRetry,
}: {
  loading?: boolean;
  loadingLines?: number;
  errorMessage?: string;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <SafeScreen>
      {loading ? <LoadingState lines={loadingLines} /> : <ErrorState message={errorMessage} onRetry={onRetry} />}
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  container: { alignSelf: 'stretch' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
