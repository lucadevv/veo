import React, { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  type ListRenderItemInfo,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, SafeScreen, Skeleton, useKeyboardHeight, useTheme } from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { IconArrowRight } from '../../../../shared/presentation/icons';
import { isTripActive, parseTripStatus } from '../../../trips/domain';
import { useTrip } from '../hooks/useTrip';
import type { Message } from '../../domain';
import { MessageBubble } from '../components/MessageBubble';
import { QuickReplies } from '../components/QuickReplies';
import { useChatHistory, useChatMessages, useMarkChatRead, useSendMessage } from '../hooks/useChat';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

const MAX_BODY = 500;

const keyExtractor = (item: Message): string => item.id;

export const ChatScreen = ({ navigation, route }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { tripId } = route.params;

  const trip = useTrip(tripId);
  const history = useChatHistory(tripId);
  const messages = useChatMessages(tripId);
  const send = useSendMessage(tripId);
  const markRead = useMarkChatRead(tripId);

  const [draft, setDraft] = useState('');
  const keyboardHeight = useKeyboardHeight();

  const status = trip.data ? parseTripStatus(trip.data.status) : 'UNKNOWN';
  // Solo se conversa con el pasajero mientras el viaje sigue vivo (no completado/cancelado).
  const active = isTripActive(status);
  const canSend = active && draft.trim().length > 0 && !send.isPending;

  // Al entrar (y al volver de background) marcamos el chat como leído: limpia el badge de TripActive.
  useFocusEffect(
    useCallback(() => {
      markRead();
    }, [markRead]),
  );

  // Lista INVERTIDA (patrón chat, espejo del pasajero): el offset 0 es el PIE de la conversación,
  // así el último mensaje (enviado o entrante) queda SIEMPRE a la vista — al llegar uno nuevo, al
  // abrir el teclado y al entrar. Reemplaza al scrollToEnd imperativo, que corría a destiempo del
  // layout. `inverted` pinta al revés → se le da la data REVERSA (el orden visual queda idéntico).
  const invertedMessages = useMemo(() => [...messages].reverse(), [messages]);

  // SOLO 2 plantillas (regla del dueño): las más coherentes para el conductor — llegando / llegué.
  const quickReplies = useMemo(
    () => [t('chat.templates.arriving'), t('chat.templates.arrived')],
    [t],
  );

  const submit = useCallback(
    (text: string) => {
      const body = text.trim();
      if (!active || body.length === 0 || send.isPending) {
        return;
      }
      send.mutate(body, { onSuccess: () => setDraft('') });
    },
    [active, send],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Message>) => <MessageBubble message={item} />,
    [],
  );

  // Header fiel al frame C/Chat: el PRIMER nombre del pasajero (server-authoritative, PII mínima) o el
  // título genérico mientras carga / si el backend no lo resolvió.
  const header = (
    <View style={styles.headerPad}>
      <TopBar
        title={trip.data?.passengerFirstName ?? t('chat.title')}
        onBack={navigation.goBack}
      />
    </View>
  );

  if (trip.isLoading) {
    return (
      <SafeScreen header={header} padded>
        <Skeleton height={56} />
        <View style={styles.skeletonGap} />
        <Skeleton height={56} />
      </SafeScreen>
    );
  }

  if (trip.isError || !trip.data) {
    return (
      <SafeScreen header={header}>
        <StateView
          title={t('errors.generic')}
          description={toErrorMessage(trip.error, t)}
          action={{ label: t('common.retry'), onPress: () => trip.refetch() }}
        />
      </SafeScreen>
    );
  }

  const showEmpty = !history.isLoading && messages.length === 0;

  return (
    <SafeScreen padded={false} header={header}>
      {/* Padding inferior = alto EXACTO del teclado en coordenadas de ventana (useKeyboardHeight,
          compartido con el pasajero): composer siempre COMPLETO encima, en cualquier dispositivo. */}
      <View style={[styles.flex, { paddingBottom: keyboardHeight }]}>
        {history.isLoading && messages.length === 0 ? (
          <View style={styles.loading}>
            <Skeleton height={44} />
            <Skeleton height={44} />
            <Skeleton height={44} />
          </View>
        ) : showEmpty ? (
          <StateView title={t('chat.emptyTitle')} description={t('chat.emptyBody')} />
        ) : (
          <FlatList
            data={invertedMessages}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            inverted
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="interactive"
          />
        )}

        {!active ? (
          <View style={styles.bannerPad}>
            <Banner
              tone="warn"
              title={t('chat.inactiveTitle')}
              description={t('chat.inactiveBody')}
            />
          </View>
        ) : null}

        {send.isError ? (
          <View style={styles.bannerPad}>
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(send.error, t)}
            />
          </View>
        ) : null}

        <View
          style={[
            styles.composer,
            {
              backgroundColor: theme.colors.bg,
              borderTopColor: theme.colors.border,
              // Con el teclado abierto el home indicator queda tapado → su inset sobraría como
              // hueco muerto entre composer y teclado; se paga solo con el teclado cerrado.
              paddingBottom: (keyboardHeight > 0 ? 0 : insets.bottom) + 8,
            },
          ]}
        >
          {/* UN solo contenedor (regla del dueño): respuestas rápidas + input + enviar en la MISMA
              card — antes los chips flotaban sueltos arriba del composer. Mismo diseño que el chat
              del pasajero (simetría entre apps). */}
          <View
            style={[
              styles.composerCard,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.xl,
                padding: theme.spacing.md,
                gap: theme.spacing.sm,
              },
            ]}
          >
            {active ? (
              <QuickReplies replies={quickReplies} onSelect={submit} disabled={send.isPending} />
            ) : null}
            <View style={[styles.inputRow, { gap: theme.spacing.sm }]}>
              {/* Input DESNUDO (sin su propia caja): la card ya es el contenedor visual. */}
              <TextInput
                style={[styles.input, { color: theme.colors.ink }]}
                value={draft}
                onChangeText={setDraft}
                editable={active && !send.isPending}
                placeholder={active ? t('chat.inputPlaceholder') : t('chat.inputDisabled')}
                placeholderTextColor={theme.colors.inkSubtle}
                multiline
                maxLength={MAX_BODY}
                returnKeyType="send"
                blurOnSubmit={false}
                onSubmitEditing={() => submit(draft)}
                accessibilityLabel={t('chat.inputPlaceholder')}
              />
              {/* Botón enviar: círculo VERDE (accentStrong) + flecha → COMPLETA, activo solo con
                  texto; deshabilitado queda gris (recesado). Espejo exacto del pasajero. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('chat.send')}
                accessibilityState={{ disabled: !canSend }}
                disabled={!canSend}
                onPress={() => submit(draft)}
                style={({ pressed }) => [
                  styles.sendBtn,
                  {
                    backgroundColor: canSend
                      ? theme.colors.accentStrong
                      : theme.colors.surfaceMuted,
                    opacity: pressed && canSend ? 0.85 : 1,
                  },
                ]}
              >
                <IconArrowRight
                  size={22}
                  color={canSend ? theme.colors.onBrand : theme.colors.inkSubtle}
                />
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerPad: { paddingHorizontal: 20 },
  skeletonGap: { height: 12 },
  loading: { flex: 1, gap: 10, paddingHorizontal: 16, paddingTop: 16 },
  // OJO: lista `inverted` — su flex-start YA es el pie visual; un justifyContent flex-end acá la
  // anclaría al TOPE (espejado).
  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  bannerPad: { paddingHorizontal: 16, paddingTop: 8 },
  composer: {
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composerCard: { borderWidth: StyleSheet.hairlineWidth },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end' },
  input: { flex: 1, fontSize: 16, maxHeight: 120, minHeight: 44, paddingTop: 12, paddingBottom: 12 },
  sendBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
