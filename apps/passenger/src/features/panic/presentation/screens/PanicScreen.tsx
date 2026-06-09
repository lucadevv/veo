import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { PanicTriggerResult } from '@veo/api-client';
import { useMutation } from '@tanstack/react-query';
import { Banner, Button, Card, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { NotImplementedError } from '../../../../core/errors/notImplemented';
import type { RootStackParamList } from '../../../../navigation/types';
import { hexAlpha } from '../components/color';
import { IconCheck, IconShield } from '../components/icons';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Params = RouteProp<RootStackParamList, 'Panic'>;

const BADGE = 84;

/**
 * Pantalla de pánico "¿Necesitas ayuda?" (acceso MANUAL), fiel al design-handoff canónico
 * (`Panic`/`S_Panic`): badge circular tintado de peligro con escudo, título danger, copia de
 * seguridad y, al confirmar, badge success con check + ID de alerta.
 *
 * Lógica intacta: dispara `POST /panic` (HMAC) vía `TriggerPanicUseCase`, que obtiene la ubicación
 * (puerto nativo), genera dedupKey y firma el mensaje (puerto nativo). Mientras esos puertos no
 * existan (oleada nativa), degrada con un mensaje claro sin enviar datos inventados.
 *
 * La DETECCIÓN automática (triple volumen, background) la añade la oleada nativa vía `PanicTrigger`:
 * aquí se anota como "Próximamente" sin simularla, según la regla de seguridad.
 */
export function PanicScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Params>();
  const trigger = useDependency(TOKENS.triggerPanicUseCase);

  const mutation = useMutation<PanicTriggerResult, Error, void>({
    mutationFn: () => trigger.execute(params.tripId),
  });

  const errorMessage =
    mutation.error instanceof NotImplementedError
      ? t('panic.errorLocation')
      : t('panic.errorGeneric');

  if (mutation.isSuccess) {
    return (
      <SafeScreen
        footer={<Button label={t('panic.back')} fullWidth size="lg" onPress={() => navigation.goBack()} />}
      >
        <View style={[styles.center, { gap: theme.spacing.lg }]}>
          <View
            style={[
              styles.badge,
              {
                backgroundColor: hexAlpha(theme.colors.success, 0.14),
                borderColor: hexAlpha(theme.colors.success, 0.4),
                borderRadius: theme.radii.pill,
              },
            ]}
          >
            <IconCheck color={theme.colors.success} size={40} />
          </View>
          <Text variant="display" color="success" align="center">
            {t('panic.sentTitle')}
          </Text>
          <Text variant="body" color="inkMuted" align="center">
            {t('panic.sentBody')}
          </Text>
          <Card variant="outlined" padding="lg">
            <Text variant="subhead" color="inkMuted">
              {t('panic.alertId')}
            </Text>
            <Text variant="bodyStrong" tabular selectable>
              {mutation.data.panicId}
            </Text>
            {mutation.data.deduplicated ? (
              <Text variant="footnote" color="inkMuted" style={{ marginTop: theme.spacing.sm }}>
                {t('panic.deduplicated')}
              </Text>
            ) : null}
          </Card>
        </View>
      </SafeScreen>
    );
  }

  return (
    <SafeScreen
      footer={
        <View style={{ gap: theme.spacing.sm }}>
          <Button
            label={mutation.isPending ? t('panic.sending') : t('panic.trigger')}
            variant="danger"
            fullWidth
            size="lg"
            loading={mutation.isPending}
            // Anti doble-tap: en el camino de EMERGENCIA, dos taps rápidos podían disparar 2 alertas con
            // dedupKeys distintos (el server dedup por key, pero el cliente generaba 2). `disabled` corta
            // el 2º tap apenas arranca el envío (no esperamos a que `loading` repinte).
            disabled={mutation.isPending}
            onPress={() => mutation.mutate()}
          />
          <Button
            label={t('panic.close')}
            variant="ghost"
            fullWidth
            onPress={() => navigation.goBack()}
          />
        </View>
      }
    >
      <View style={[styles.center, { gap: theme.spacing.lg }]}>
        <View
          style={[
            styles.badge,
            {
              backgroundColor: hexAlpha(theme.colors.danger, 0.12),
              borderColor: hexAlpha(theme.colors.danger, 0.4),
              borderRadius: theme.radii.pill,
            },
          ]}
        >
          <IconShield color={theme.colors.danger} size={40} />
        </View>
        <Text variant="display" color="danger" align="center">
          {t('panic.title')}
        </Text>
        <Text variant="body" color="inkMuted" align="center">
          {t('panic.subtitle')}
        </Text>
        {mutation.isError ? <Banner tone="danger" title={errorMessage} /> : null}
        {/* El aviso "próximamente: 3× volumen" se quitó de la pantalla de EMERGENCIA: en el momento
            crítico distrae y resta confianza (anunciar una feature faltante). Va en onboarding/ajustes
            donde el usuario aprende las features de seguridad con calma. */}
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  badge: {
    width: BADGE,
    height: BADGE,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
