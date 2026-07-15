import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {PanicTriggerResult} from '@veo/api-client';
import {useMutation} from '@tanstack/react-query';
import {
  Banner,
  Button,
  hexAlpha,
  SafeScreen,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Linking, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {NotImplementedError} from '../../../../core/errors/notImplemented';
import type {RootStackParamList} from '../../../../navigation/types';
import {
  IconCheck,
  IconHash,
  IconMapPin,
  IconPhone,
  IconRadioTower,
  IconShield,
  IconShieldCheck,
  IconUsers,
} from '../components/icons';

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
 *
 * Con `escalated: true` en los params (escalamiento del disparo SILENCIOSO fallido, ver
 * `NavigationPanicEscalation`), la pantalla NO arranca neutra: muestra de entrada el banner de
 * urgencia "no pudimos enviar tu alerta silenciosa" con el CTA de reintento como protagonista.
 */
export function PanicScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<Params>();
  const trigger = useDependency(TOKENS.triggerPanicUseCase);

  const mutation = useMutation<PanicTriggerResult, Error, void>({
    mutationFn: () => trigger.execute(params.tripId),
  });

  const errorMessage =
    mutation.error instanceof NotImplementedError
      ? t('panic.errorLocation')
      : t('panic.errorGeneric');

  if (mutation.isSuccess) {
    // Confirmaciones del estado ENVIADO (pen EZSxZ). El 202 del panic-service garantiza persistencia
    // + outbox; el fan-out DOCUMENTADO (BR-S05: SMS+link a los contactos, push a la central) lo
    // ejecuta notification-service consumiendo `panic.triggered`. La respuesta no distingue por ítem,
    // así que la lista refleja ese fan-out estándar, no acks individuales.
    const confirmations = [
      {key: 'location', label: t('panic.statusLocation'), Icon: IconMapPin},
      {key: 'contacts', label: t('panic.statusContacts'), Icon: IconUsers},
      {key: 'central', label: t('panic.statusCentral'), Icon: IconRadioTower},
    ] as const;

    return (
      <SafeScreen
        footer={
          <View style={{gap: theme.spacing.sm}}>
            {/* CTA de emergencia per pen: llamada directa al 105 (PNP). Prominente y danger porque
                es el siguiente paso crítico si la situación escala más allá de la alerta. */}
            <Button
              label={t('panic.call105')}
              variant="danger"
              fullWidth
              size="lg"
              leftIcon={<IconPhone color={theme.colors.onDanger} size={20} />}
              onPress={() => void Linking.openURL('tel:105')}
            />
            <Button
              label={t('panic.back')}
              variant="ghost"
              fullWidth
              onPress={() => navigation.goBack()}
            />
          </View>
        }>
        <View style={[styles.center, {gap: theme.spacing.lg}]}>
          {/* Emblema shield-check (pen): halo success suave + disco success sólido, no un check pelado. */}
          <View
            style={[
              styles.emblemHalo,
              {
                backgroundColor: hexAlpha(theme.colors.success, 0.14),
                borderRadius: theme.radii.pill,
              },
            ]}>
            <View
              style={[
                styles.emblem,
                {
                  backgroundColor: theme.colors.success,
                  borderRadius: theme.radii.pill,
                },
              ]}>
              <IconShieldCheck color={theme.colors.onSuccess} size={40} />
            </View>
          </View>
          <Text variant="display" align="center">
            {t('panic.sentTitle')}
          </Text>
          <Text variant="body" color="inkMuted" align="center">
            {t('panic.sentBody')}
          </Text>

          {/* Chip compacto del ID de alerta (hash + id en mono), no una Card grande. */}
          <View
            style={[
              styles.idChip,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.borderStrong,
                borderRadius: theme.radii.pill,
                paddingVertical: theme.spacing.sm,
                paddingHorizontal: theme.spacing.md,
                gap: theme.spacing.sm,
              },
            ]}
            accessible
            accessibilityLabel={`${t('panic.alertId')}: ${mutation.data.panicId}`}>
            <IconHash color={theme.colors.inkSubtle} size={15} />
            <Text variant="footnote" color="inkMuted" tabular selectable>
              {mutation.data.panicId}
            </Text>
          </View>
          {mutation.data.deduplicated ? (
            <Text variant="footnote" color="inkMuted" align="center">
              {t('panic.deduplicated')}
            </Text>
          ) : null}

          {/* StatusList del fan-out (pen): ubicación · contactos · central, con check success. */}
          <View style={[styles.statusList, {gap: theme.spacing.sm}]}>
            {confirmations.map(({key, label, Icon}) => (
              <View
                key={key}
                style={[
                  styles.statusRow,
                  {
                    backgroundColor: theme.colors.surface,
                    borderRadius: theme.radii.md,
                    padding: theme.spacing.md,
                    gap: theme.spacing.md,
                  },
                ]}>
                <View
                  style={[
                    styles.statusIconWrap,
                    {
                      backgroundColor: hexAlpha(theme.colors.success, 0.14),
                      borderRadius: theme.radii.pill,
                    },
                  ]}>
                  <Icon color={theme.colors.success} size={16} />
                </View>
                <Text variant="callout" style={styles.statusLabel}>
                  {label}
                </Text>
                <IconCheck color={theme.colors.success} size={18} />
              </View>
            ))}
          </View>
        </View>
      </SafeScreen>
    );
  }

  return (
    <SafeScreen
      footer={
        <View style={{gap: theme.spacing.sm}}>
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
      }>
      <View style={[styles.center, {gap: theme.spacing.lg}]}>
        <View
          style={[
            styles.badge,
            {
              backgroundColor: hexAlpha(theme.colors.danger, 0.12),
              borderColor: hexAlpha(theme.colors.danger, 0.4),
              borderRadius: theme.radii.pill,
            },
          ]}>
          <IconShield color={theme.colors.danger} size={40} />
        </View>
        <Text variant="display" color="danger" align="center">
          {t('panic.title')}
        </Text>
        <Text variant="body" color="inkMuted" align="center">
          {t('panic.subtitle')}
        </Text>
        {mutation.isError ? (
          <Banner tone="danger" title={errorMessage} />
        ) : params.escalated ? (
          // Llegó por ESCALAMIENTO del disparo silencioso fallido: decir la verdad de entrada
          // (la alerta oculta NO se envió) en vez del estado neutro. Si el reintento manual
          // falla, el banner de error de arriba (más específico) lo reemplaza.
          <Banner
            tone="danger"
            title={t('panic.escalatedTitle')}
            description={t('panic.escalatedBody')}
          />
        ) : null}
        {/* El aviso "próximamente: 3× volumen" se quitó de la pantalla de EMERGENCIA: en el momento
            crítico distrae y resta confianza (anunciar una feature faltante). Va en onboarding/ajustes
            donde el usuario aprende las features de seguridad con calma. */}
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  center: {flex: 1, justifyContent: 'center', alignItems: 'center'},
  badge: {
    width: BADGE,
    height: BADGE,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  // Emblema del estado enviado (pen EZSxZ): halo 112 + disco sólido 80.
  emblemHalo: {
    width: 112,
    height: 112,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emblem: {
    width: 80,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  idChip: {flexDirection: 'row', alignItems: 'center', borderWidth: 1},
  statusList: {alignSelf: 'stretch'},
  statusRow: {flexDirection: 'row', alignItems: 'center'},
  statusIconWrap: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusLabel: {flex: 1},
});
