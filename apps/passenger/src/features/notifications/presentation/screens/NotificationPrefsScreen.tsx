import {
  Banner,
  Card,
  ListItem,
  SafeScreen,
  Switch,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Linking, ScrollView, StyleSheet, View} from 'react-native';
import type {GlyphProps} from '../icons';
import {
  IconBell,
  IconCarFront,
  IconClock,
  IconGift,
  IconShield,
  IconUser,
} from '../icons';
import {usePushPermission} from '../../../../core/notifications/usePushPermission';
import {container} from '../../../../core/di/registry';
import {TOKENS} from '../../../../core/di/tokens';
import {ScreenHeader} from '../../../../shared/presentation/components/ScreenHeader';
import type {NotificationPrefs} from '../stores/notificationPrefsStore';
import {useNotificationPrefsStore} from '../stores/notificationPrefsStore';

/**
 * Preferencias de notificaciones (design/veo.pen P/NotifPrefs): 3 grupos de toggles en cards —
 * Viajes / Seguridad / Promociones.
 *
 *  - Persistencia con FUENTE DE VERDAD server-side (notification-service, `GET/PUT
 *    /notification-prefs`): hidrata al montar y sincroniza cada cambio (PUT best-effort), con MMKV
 *    como cache offline-first vía `useNotificationPrefsStore`. La nota al pie lo dice honesto.
 *  - Los toggles de SEGURIDAD (pánico / biométrica) están SIEMPRE encendidos y deshabilitados:
 *    seguridad no negociable del producto — el pen los dibuja como toggles normales, pero apagar
 *    la confirmación de un pánico sería mentirle al usuario sobre su propia seguridad.
 *  - Si el permiso de push del SO está apagado/bloqueado, un banner arriba lo dice y ofrece la
 *    acción real (pedir permiso / abrir Ajustes): sin permiso del SO, ningún toggle entrega nada.
 *    Esto además conserva la acción que antes vivía en la fila "Notificaciones" del perfil.
 */
export function NotificationPrefsScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const push = usePushPermission();

  const prefs = useNotificationPrefsStore(state => state.prefs);
  const setPref = useNotificationPrefsStore(state => state.setPref);
  const hydrate = useNotificationPrefsStore(state => state.hydrate);

  // Hidrata desde el backend al montar (fuente de verdad server-side). Resolución PEREZOSA + GUARDADA:
  // si el binding DI aún no está cableado (lo consolida el lead en el registry), no crashea — la
  // pantalla se queda con el cache MMKV (offline-first). Si falla la red, ídem (degradación honesta).
  React.useEffect(() => {
    if (!container.has(TOKENS.getNotificationPrefsUseCase)) return;
    let cancelled = false;
    container
      .resolve(TOKENS.getNotificationPrefsUseCase)
      .execute()
      .then(server => {
        if (!cancelled) hydrate(server);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  const sectionLabel = (text: string): React.JSX.Element => (
    <Text
      variant="label"
      color="inkMuted"
      style={{marginBottom: theme.spacing.sm, marginLeft: theme.spacing.xs}}>
      {text}
    </Text>
  );

  return (
    <SafeScreen padded={false}>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing['2xl'],
        }}
        showsVerticalScrollIndicator={false}>
        {/* Header in-body (patrón ScreenHeader del pen): back pill + título display. */}
        <ScreenHeader title={t('screens.notificationPrefs')} />
        {/* Permiso de push del SO: sin él nada de esto llega. Acción honesta según el estado. */}
        {push.status === 'undetermined' ? (
          <Banner
            tone="warn"
            title={t('notifications.prefs.pushOffTitle')}
            description={t('notifications.prefs.pushOffBody')}
            action={{
              label: t('notifications.prefs.pushOffCta'),
              onPress: () => void push.enable(),
            }}
          />
        ) : push.status === 'denied' ? (
          <Banner
            tone="warn"
            title={t('notifications.prefs.pushOffTitle')}
            description={t('notifications.prefs.pushDeniedBody')}
            action={{
              label: t('notifications.prefs.pushDeniedCta'),
              onPress: () => void Linking.openSettings(),
            }}
          />
        ) : null}

        {/* Viajes */}
        <View>
          {sectionLabel(t('notifications.prefs.groupTrips'))}
          <Card variant="outlined" padding="none">
            <PrefToggleRow
              Icon={IconCarFront}
              title={t('notifications.prefs.tripStatus')}
              subtitle={t('notifications.prefs.tripStatusSub')}
              prefKey="tripStatus"
              value={prefs.tripStatus}
              onChange={setPref}
            />
            <RowDivider />
            <PrefToggleRow
              Icon={IconClock}
              title={t('notifications.prefs.driverEnRoute')}
              subtitle={t('notifications.prefs.driverEnRouteSub')}
              prefKey="driverEnRoute"
              value={prefs.driverEnRoute}
              onChange={setPref}
            />
            <RowDivider />
            <PrefToggleRow
              Icon={IconBell}
              title={t('notifications.prefs.scheduledReminders')}
              subtitle={t('notifications.prefs.scheduledRemindersSub')}
              prefKey="scheduledReminders"
              value={prefs.scheduledReminders}
              onChange={setPref}
            />
          </Card>
        </View>

        {/* Seguridad: SIEMPRE activas (no negociable). ON + deshabilitado, con subtítulo honesto. */}
        <View>
          {sectionLabel(t('notifications.prefs.groupSafety'))}
          <Card variant="outlined" padding="none">
            <LockedRow
              Icon={IconShield}
              title={t('notifications.prefs.panicAlerts')}
              subtitle={t('notifications.prefs.alwaysOn')}
            />
            <RowDivider />
            <LockedRow
              Icon={IconUser}
              title={t('notifications.prefs.biometricAlerts')}
              subtitle={t('notifications.prefs.alwaysOn')}
            />
          </Card>
        </View>

        {/* Promociones */}
        <View>
          {sectionLabel(t('notifications.prefs.groupPromos'))}
          <Card variant="outlined" padding="none">
            <PrefToggleRow
              Icon={IconGift}
              title={t('notifications.prefs.offers')}
              subtitle={t('notifications.prefs.offersSub')}
              prefKey="offers"
              value={prefs.offers}
              onChange={setPref}
            />
            <RowDivider />
            <PrefToggleRow
              Icon={IconBell}
              title={t('notifications.prefs.news')}
              subtitle={t('notifications.prefs.newsSub')}
              prefKey="news"
              value={prefs.news}
              onChange={setPref}
            />
          </Card>
        </View>

        {/* Gap de backend dicho honesto: las preferencias viven solo en este dispositivo. */}
        <Text variant="footnote" color="inkSubtle" align="center">
          {t('notifications.prefs.localNote')}
        </Text>
      </ScrollView>
    </SafeScreen>
  );
}

interface BaseRowProps {
  Icon: (props: GlyphProps) => React.JSX.Element;
  title: string;
  subtitle: string;
}

interface PrefToggleRowProps extends BaseRowProps {
  prefKey: keyof NotificationPrefs;
  value: boolean;
  onChange: (key: keyof NotificationPrefs, value: boolean) => void;
}

/** Fila del pen (icono 20 + título/sub + switch a la derecha, padding 14/16). */
function PrefToggleRow({
  Icon,
  title,
  subtitle,
  prefKey,
  value,
  onChange,
}: PrefToggleRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <ListItem
      style={styles.prefRow}
      leading={<Icon color={theme.colors.inkMuted} size={20} />}
      title={title}
      subtitle={subtitle}
      trailing={
        <Switch
          value={value}
          onValueChange={next => onChange(prefKey, next)}
          accessibilityLabel={title}
        />
      }
    />
  );
}

/**
 * Fila de SEGURIDAD: switch encendido y deshabilitado (pánico/biométrica no se apagan por diseño
 * del producto). El `onValueChange` es no-op consciente: el Switch es controlado y `disabled`
 * bloquea el press, pero el contrato pide la prop.
 */
function LockedRow({Icon, title, subtitle}: BaseRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <ListItem
      style={styles.prefRow}
      leading={<Icon color={theme.colors.inkMuted} size={20} />}
      title={title}
      subtitle={subtitle}
      trailing={
        <Switch
          value
          disabled
          onValueChange={() => undefined}
          accessibilityLabel={title}
        />
      }
    />
  );
}

/** Divisor per pen: línea de 1px con sangría izquierda de 52 (alineada al texto, no al icono). */
function RowDivider(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.dividerWrap}>
      <View style={[styles.divider, {backgroundColor: theme.colors.border}]} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Conserva el inset horizontal de 16 del pen (ListItem default = xs/4, pegaría el icono al borde
  // de la card padding="none"); el gap lg del kit alinea el texto al indent 52 del divisor.
  prefRow: {paddingHorizontal: 16},
  dividerWrap: {paddingLeft: 52},
  divider: {height: StyleSheet.hairlineWidth},
});
