import {useRoute, type RouteProp} from '@react-navigation/native';
import {useMutation, useQuery} from '@tanstack/react-query';
import {
  Banner,
  Button,
  Card,
  SafeScreen,
  Skeleton,
  Text,
  hexAlpha,
  useTheme,
} from '@veo/ui-kit';
import React, {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
  Clipboard,
  Linking,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  View,
} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import type {RootStackParamList} from '../../../../navigation/types';
import {ScreenHeader} from '../../../../shared/presentation/components/ScreenHeader';
import type {TrustedContact} from '../../../contacts/domain/entities';
import {
  IconChat,
  IconCopy,
  IconMessageSquare,
  IconShare,
  IconUsers,
} from '../components/icons';
import {useActiveTripStore} from '../stores/activeTripStore';

type Params = RouteProp<RootStackParamList, 'FamilyShare'>;

/**
 * "Comparte tu viaje" (design/veo.pen zKyic): pantalla dedicada del enlace de seguimiento familiar.
 *
 * REALIDAD del backend (verificada en share-service):
 *  - El enlace es REAL: `POST /share/:tripId` (TTL default 2 h) y share-service lo REVOCA solo al
 *    terminar el viaje (consumer de trip.completed/cancelled/failed) → el copy "caduca al terminar
 *    tu viaje" es verdad literal.
 *  - NO hay GET del share activo ni dedup sin dedupKey: cada POST crea un enlace nuevo. Por eso el
 *    enlace de la sesión se RETIENE en `activeTripStore` (shareUrl) y se REUSA al re-entrar, en vez
 *    de fabricar uno por visita.
 *  - NO existe "notificar al contacto" server-side al compartir (el SMS automático es solo del
 *    pánico): los switches "Compartir automático" del pen serían mentira → cada contacto verificado
 *    lleva "Enviar SMS" (abre el compositor del teléfono con el enlace), que SÍ es real.
 */
export function FamilyShareScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const {params} = useRoute<Params>();
  const {tripId} = params;

  const shareTrip = useDependency(TOKENS.shareTripUseCase);
  const revokeShare = useDependency(TOKENS.revokeShareUseCase);
  const listContacts = useDependency(TOKENS.listContactsUseCase);

  // Enlace activo retenido por la sesión (mismo store que el kill-switch del viaje activo).
  const activeShareId = useActiveTripStore(s => s.activeShareId);
  const shareExpiresAt = useActiveTripStore(s => s.shareExpiresAt);
  const shareUrl = useActiveTripStore(s => s.shareUrl);
  const setActiveShare = useActiveTripStore(s => s.setActiveShare);
  const clearShare = useActiveTripStore(s => s.clearShare);

  const [copied, setCopied] = useState(false);
  // Tras revocar NO se auto-regenera (sería deshacer el gesto del usuario): estado explícito con
  // CTA "Generar nuevo enlace".
  const [justRevoked, setJustRevoked] = useState(false);

  // Un enlace retenido pero ya vencido (TTL 2 h) no sirve: se trata como ausente y se crea otro.
  const isExpired =
    shareExpiresAt != null && new Date(shareExpiresAt).getTime() <= Date.now();
  const activeUrl = !isExpired ? shareUrl : null;

  const createMutation = useMutation({
    mutationFn: () => shareTrip.execute(tripId),
    onSuccess: link => {
      // Se retiene TODO el enlace (id + caducidad + URL): revocable y reusable al re-entrar.
      setActiveShare(link.shareId, link.expiresAt, link.url);
      setJustRevoked(false);
    },
  });
  // `mutate` es estable en React Query; se referencia entero para no silenciar el linter con casts.
  const {mutate: createShare, status: createStatus} = createMutation;

  // Al montar: crea el enlace REAL solo si la sesión no retiene uno vivo (ver cabecera del archivo).
  useEffect(() => {
    if (activeUrl == null && !justRevoked && createStatus === 'idle') {
      createShare();
    }
  }, [activeUrl, justRevoked, createStatus, createShare]);

  const revokeMutation = useMutation({
    mutationFn: () => {
      if (!activeShareId) {
        throw new Error('no-active-share');
      }
      return revokeShare.execute(activeShareId);
    },
    onSuccess: () => {
      clearShare();
      setJustRevoked(true);
    },
  });

  // Contactos de confianza REALES (repo de features/contacts; misma queryKey que el resto de la app).
  const contactsQuery = useQuery({
    queryKey: ['contacts'],
    queryFn: () => listContacts.execute(),
  });
  const contacts = contactsQuery.data ?? [];

  const shareMessage =
    activeUrl != null ? t('trip.shareMessage', {url: activeUrl}) : null;

  const onCopy = (): void => {
    if (activeUrl == null) {
      return;
    }
    Clipboard.setString(activeUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  // WhatsApp por deep link; si la app no está instalada cae al enlace universal wa.me.
  const onWhatsApp = (): void => {
    if (shareMessage == null) {
      return;
    }
    const encoded = encodeURIComponent(shareMessage);
    Linking.openURL(`whatsapp://send?text=${encoded}`).catch(() => {
      void Linking.openURL(`https://wa.me/?text=${encoded}`).catch(
        () => undefined,
      );
    });
  };

  // Compositor de SMS del sistema. iOS separa el body con '&'; Android con '?'.
  const onSms = (phone?: string): void => {
    if (shareMessage == null) {
      return;
    }
    const separator = Platform.OS === 'ios' ? '&' : '?';
    void Linking.openURL(
      `sms:${phone ?? ''}${separator}body=${encodeURIComponent(shareMessage)}`,
    ).catch(() => undefined);
  };

  // Hoja nativa de compartir ("Más" y el CTA grande del pen).
  const onNativeShare = (): void => {
    if (activeUrl == null || shareMessage == null) {
      return;
    }
    void Share.share({
      title: t('trip.shareTitle'),
      message: shareMessage,
      url: activeUrl,
    }).catch(() => undefined);
  };

  // Tinte tenue de marca (pen $brand-dim): derivado del brand con alpha, igual que en Referrals.
  const brandDim = hexAlpha(
    theme.colors.brand,
    theme.scheme === 'dark' ? 0.18 : 0.12,
  );

  return (
    <SafeScreen
      padded={false}
      scroll
      contentContainerStyle={{
        padding: theme.spacing.xl,
        gap: theme.spacing['2xl'],
      }}
      footer={
        <Button
          label={t('familyShare.shareCta')}
          variant="primary"
          fullWidth
          disabled={activeUrl == null}
          onPress={onNativeShare}
        />
      }>
      {/* Header in-body (patrón ScreenHeader del pen): back pill + título display. */}
      <ScreenHeader title={t('screens.familyShare')} />
      {/* Intro per pen: icono users en círculo brand-dim + promesa VERDADERA (share-service revoca
          los enlaces al terminar el viaje; TTL 2 h). */}
      <View style={[styles.intro, {gap: theme.spacing.lg}]}>
        <View style={[styles.introCircle, {backgroundColor: brandDim}]}>
          <IconUsers color={theme.colors.brand} size={30} />
        </View>
        <Text variant="callout" color="inkMuted" align="center">
          {t('familyShare.intro')}
        </Text>
      </View>

      {/* LinkCard per pen: etiqueta + URL mono + pill "Copiar". Estados honestos del POST real. */}
      {createMutation.isError && activeUrl == null ? (
        <View style={{gap: theme.spacing.sm}}>
          <Banner tone="danger" title={t('trip.shareError')} />
          <Button
            label={t('actions.retry')}
            variant="secondary"
            fullWidth
            onPress={() => createShare()}
          />
        </View>
      ) : justRevoked && activeUrl == null ? (
        <View style={{gap: theme.spacing.sm}}>
          <Banner tone="success" title={t('trip.shareRevokedBanner')} />
          <Button
            label={t('familyShare.regenerate')}
            variant="secondary"
            fullWidth
            onPress={() => createShare()}
          />
        </View>
      ) : activeUrl == null ? (
        <View style={{gap: theme.spacing.sm}}>
          <Skeleton variant="rect" height={64} />
          <Text variant="footnote" color="inkMuted" align="center">
            {t('familyShare.creating')}
          </Text>
        </View>
      ) : (
        <Card variant="outlined" padding="lg">
          <View style={[styles.linkRow, {gap: theme.spacing.md}]}>
            <View style={[styles.linkTexts, {gap: theme.spacing.xxs}]}>
              <Text variant="caption" color="inkSubtle">
                {t('familyShare.linkLabel')}
              </Text>
              <Text
                variant="body"
                numberOfLines={1}
                style={{fontFamily: theme.typography.fontFamily.mono}}>
                {activeUrl}
              </Text>
            </View>
            <Pressable
              onPress={onCopy}
              accessibilityRole="button"
              accessibilityLabel={t('familyShare.copy')}
              style={[
                styles.copyPill,
                {
                  backgroundColor: brandDim,
                  borderRadius: theme.radii.pill,
                  gap: theme.spacing.xs,
                },
              ]}>
              <IconCopy color={theme.colors.brand} size={16} />
              <Text variant="footnote" style={{color: theme.colors.brand}}>
                {copied ? t('familyShare.copied') : t('familyShare.copy')}
              </Text>
            </Pressable>
          </View>
        </Card>
      )}

      {/* Canales per pen: WhatsApp · Mensajes · Más (hoja nativa). Deshabilitados sin enlace. */}
      <View style={[styles.channels, {gap: theme.spacing.md}]}>
        <ChannelTile
          icon={<IconChat color={theme.colors.ink} size={22} />}
          label={t('familyShare.channelWhatsApp')}
          disabled={activeUrl == null}
          onPress={onWhatsApp}
        />
        <ChannelTile
          icon={<IconMessageSquare color={theme.colors.ink} size={22} />}
          label={t('familyShare.channelSms')}
          disabled={activeUrl == null}
          onPress={() => onSms()}
        />
        <ChannelTile
          icon={<IconShare color={theme.colors.ink} size={22} />}
          label={t('familyShare.channelMore')}
          disabled={activeUrl == null}
          onPress={onNativeShare}
        />
      </View>

      {/* Contactos de confianza REALES. Sin switches de "compartir automático" (no hay backend que
          los sustente): "Enviar SMS" abre el compositor con el enlace, que sí es real. */}
      {contacts.length > 0 ? (
        <View style={{gap: theme.spacing.sm}}>
          {contacts.map(contact => (
            <ContactRow
              key={contact.id}
              contact={contact}
              disabled={activeUrl == null}
              onSendSms={() => onSms(contact.phone)}
            />
          ))}
        </View>
      ) : null}

      {/* Nota de caducidad per pen: VERDAD literal (revocación automática al terminar el viaje). */}
      <Banner tone="success" title={t('familyShare.expiryNote')} />

      {revokeMutation.isError ? (
        <Banner tone="danger" title={t('trip.revokeShareError')} />
      ) : null}

      {/* Kill-switch (D6): visible solo con un enlace vivo de esta sesión. */}
      {activeShareId != null && activeUrl != null ? (
        <Button
          label={t('trip.revokeShare')}
          variant="secondary"
          fullWidth
          loading={revokeMutation.isPending}
          onPress={() => revokeMutation.mutate()}
        />
      ) : null}
    </SafeScreen>
  );
}

interface ChannelTileProps {
  icon: React.ReactNode;
  label: string;
  disabled: boolean;
  onPress: () => void;
}

/** Tile de canal (pen zKyic Channels): círculo de superficie con el icono + etiqueta corta debajo. */
function ChannelTile({
  icon,
  label,
  disabled,
  onPress,
}: ChannelTileProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({pressed}) => [
        styles.channelTile,
        {gap: theme.spacing.xs, opacity: disabled ? 0.45 : pressed ? 0.7 : 1},
      ]}>
      <View
        style={[
          styles.channelCircle,
          {backgroundColor: theme.colors.surface},
        ]}>
        {icon}
      </View>
      <Text variant="footnote" color="inkMuted">
        {label}
      </Text>
    </Pressable>
  );
}

interface ContactRowProps {
  contact: TrustedContact;
  disabled: boolean;
  onSendSms: () => void;
}

/**
 * Fila de contacto (pen zKyic Contacts): avatar con inicial + nombre + teléfono real (en lugar del
 * "Compartir automático" del pen, que no existe en el backend) + acción "Enviar SMS".
 */
function ContactRow({
  contact,
  disabled,
  onSendSms,
}: ContactRowProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const initial = contact.name.trim().charAt(0).toUpperCase() || '·';
  return (
    <View
      style={[
        styles.contactRow,
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.lg,
          paddingVertical: theme.spacing.md,
          paddingHorizontal: theme.spacing.lg,
          gap: theme.spacing.md,
        },
      ]}>
      <View
        style={[
          styles.contactAvatar,
          {backgroundColor: theme.colors.surfaceElevated},
        ]}>
        <Text variant="bodyStrong" color="inkMuted">
          {initial}
        </Text>
      </View>
      <View style={[styles.contactTexts, {gap: theme.spacing.xxs}]}>
        <Text variant="body" numberOfLines={1}>
          {contact.name}
        </Text>
        <Text variant="caption" color="inkSubtle" numberOfLines={1}>
          {contact.phone}
        </Text>
      </View>
      <Button
        label={t('familyShare.contactSms')}
        variant="secondary"
        size="sm"
        disabled={disabled}
        onPress={onSendSms}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  intro: {alignItems: 'center'},
  introCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  linkTexts: {flex: 1},
  copyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  channels: {flexDirection: 'row'},
  channelTile: {flex: 1, alignItems: 'center'},
  channelCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactRow: {flexDirection: 'row', alignItems: 'center'},
  contactAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactTexts: {flex: 1},
});
