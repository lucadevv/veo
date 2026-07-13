import type {ChatMessage} from '@veo/api-client';
import {useRoute, type RouteProp} from '@react-navigation/native';
import {useMutation, useQuery} from '@tanstack/react-query';
import {Banner, SafeScreen, Text, TextField, useTheme} from '@veo/ui-kit';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import type {RootStackParamList} from '../../../../navigation/types';
import {usePassengerTripSocket} from '../../../../core/realtime/usePassengerTripSocket';
import {isChatActive, mergeMessages} from '../../domain/entities';
import {withDayDividers, type ChatListItem} from '../dayDividers';
import {MessageBubble} from '../components/MessageBubble';
import {IconArrowRight} from '../../../trip/presentation/components/icons';

type Params = RouteProp<RootStackParamList, 'Chat'>;

/** Plantillas rápidas (claves i18n) para coordinar el recojo con un toque. */
const QUICK_REPLY_KEYS = ['leaving', 'atDoor', 'onMyWay', 'waiting'] as const;

/**
 * Conversación con el conductor (Ola 2A). Historial inicial por REST (`GET /trips/:id/messages`),
 * mensajes entrantes en vivo por el socket `/passenger` (`chat:message`) y envío por
 * `POST /trips/:id/messages`. Burbujas propias en acento a la derecha, del conductor en superficie a
 * la izquierda. Si el viaje terminó, el chat queda en solo lectura (input deshabilitado).
 */
export function ChatScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const insets = useSafeAreaInsets();
  const {params} = useRoute<Params>();
  const {tripId} = params;

  const listMessages = useDependency(TOKENS.listMessagesUseCase);
  const sendMessage = useDependency(TOKENS.sendMessageUseCase);

  const live = usePassengerTripSocket(tripId);
  const {acknowledgeMessages} = live;

  const historyQuery = useQuery({
    queryKey: ['chat', tripId, 'messages'],
    queryFn: () => listMessages.execute(tripId),
  });

  // Mensajes confirmados localmente tras enviar (eco optimista del POST hasta que llegue por socket).
  const [sentMessages, setSentMessages] = useState<ChatMessage[]>([]);
  // Mensajes ENTRANTES del conductor ya integrados (acumulados de forma ESTABLE). El socket los deja en
  // `live.incomingMessages` como buffer TRANSITORIO y `acknowledgeMessages` los DRENA; si no los
  // copiáramos acá antes de drenar, el mensaje del conductor aparecía un instante y DESAPARECÍA (había
  // que salir y re-entrar para que el historial REST lo trajera). Ahora persisten en la pantalla en vivo.
  const [receivedMessages, setReceivedMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList<ChatListItem>>(null);

  const sendMutation = useMutation({
    mutationFn: (body: string) => sendMessage.execute(tripId, body),
    onSuccess: message => {
      setSentMessages(prev =>
        prev.some(existing => existing.id === message.id)
          ? prev
          : [...prev, message],
      );
      setDraft('');
    },
  });

  // Lista única y estable: historial + enviados + entrantes YA acumulados, deduplicados y ordenados.
  const messages = useMemo(
    () =>
      mergeMessages(historyQuery.data ?? [], [
        ...sentMessages,
        ...receivedMessages,
      ]),
    [historyQuery.data, sentMessages, receivedMessages],
  );

  // Ítems de la lista CON divisores de día sintéticos (pen hPrJt DayDivider: "Hoy"/"Ayer"/"Lun 30
  // jun"), derivados de los timestamps reales. Las etiquetas se inyectan (la derivación es pura).
  const listItems = useMemo(
    () =>
      withDayDividers(messages, {
        today: t('chat.dayToday'),
        yesterday: t('chat.dayYesterday'),
      }),
    [messages, t],
  );

  // Copia los entrantes a un estado ESTABLE y DESPUÉS drena el buffer transitorio del socket (para no
  // reprocesarlos ni ensuciar el badge). El orden importa: primero acumular, luego acknowledge — así el
  // mensaje del conductor persiste en la pantalla en vivo (no depende de re-entrar para verlo).
  useEffect(() => {
    if (live.incomingMessages.length === 0) {
      return;
    }
    setReceivedMessages(prev => mergeMessages(prev, live.incomingMessages));
    acknowledgeMessages(live.incomingMessages.map(message => message.id));
  }, [live.incomingMessages, acknowledgeMessages]);

  const liveStatusKnown = live.status !== null || live.ended;
  const active = liveStatusKnown
    ? isChatActive(live.ended ? 'COMPLETED' : live.status)
    : true;
  // El envío se habilita SOLO con texto real (y viaje activo, sin envío en vuelo): el botón lo refleja.
  const canSend = draft.trim().length > 0 && !sendMutation.isPending && active;

  const onSend = useCallback(
    (body: string) => {
      const trimmed = body.trim();
      if (trimmed.length === 0 || sendMutation.isPending || !active) {
        return;
      }
      sendMutation.mutate(trimmed);
    },
    [sendMutation, active],
  );

  // Divisor de día centrado y sutil (pen: texto 11/600 ink-subtle) o burbuja según el ítem.
  const renderItem = useCallback(
    ({item}: {item: ChatListItem}) =>
      item.kind === 'divider' ? (
        <View style={styles.dayDivider}>
          <Text variant="caption" color="inkSubtle" align="center">
            {item.label}
          </Text>
        </View>
      ) : (
        <MessageBubble message={item.message} />
      ),
    [],
  );

  if (historyQuery.isLoading) {
    return (
      <SafeScreen>
        <LoadingState />
      </SafeScreen>
    );
  }

  if (historyQuery.isError) {
    return (
      <SafeScreen>
        <ErrorState onRetry={() => historyQuery.refetch()} />
      </SafeScreen>
    );
  }

  return (
    <SafeScreen padded={false}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + theme.spacing.xl}>
        <FlatList
          ref={listRef}
          style={styles.flex}
          data={listItems}
          keyExtractor={item =>
            item.kind === 'divider' ? item.id : item.message.id
          }
          renderItem={renderItem}
          // Autoscroll al final por CADA mensaje que llega/sale: se dispara al cambiar el ALTO del
          // contenido (después del layout, no antes → confiable). El composer con los chips fijos es un
          // hermano DEBAJO de la lista, así que el último mensaje queda visible sobre él, nunca tapado.
          onContentSizeChange={() =>
            listRef.current?.scrollToEnd({animated: true})
          }
          contentContainerStyle={{
            padding: theme.spacing.xl,
            gap: theme.spacing.md,
            flexGrow: 1,
          }}
          ListEmptyComponent={
            <View style={[styles.empty, {gap: theme.spacing.xs}]}>
              <Text variant="bodyStrong" align="center">
                {t('chat.empty')}
              </Text>
              <Text variant="footnote" color="inkMuted" align="center">
                {t('chat.emptySubtitle')}
              </Text>
            </View>
          }
          showsVerticalScrollIndicator={false}
        />

        {!active ? (
          <View style={{padding: theme.spacing.xl, paddingTop: 0}}>
            <Banner
              tone="info"
              title={t('chat.disabledTitle')}
              description={t('chat.disabledBody')}
            />
          </View>
        ) : (
          <View
            style={[
              styles.composer,
              {
                backgroundColor: theme.colors.bg,
                borderTopColor: theme.colors.border,
                paddingHorizontal: theme.spacing.xl,
                paddingTop: theme.spacing.md,
                paddingBottom: insets.bottom + theme.spacing.md,
                gap: theme.spacing.sm,
              },
            ]}>
            {/* Socket caído con el viaje aún activo: indicador honesto (antes no se veía nada). El envío
                por REST sigue funcionando; los mensajes entrantes en vivo se reanudan al reconectar. */}
            {!live.connected ? (
              <Text variant="caption" color="inkSubtle" align="center">
                {t('chat.reconnecting')}
              </Text>
            ) : null}

            {/* Plantillas rápidas: chips horizontales discretos. */}
            <View style={[styles.quickRow, {gap: theme.spacing.xs}]}>
              {QUICK_REPLY_KEYS.map(key => (
                <Pressable
                  key={key}
                  onPress={() => onSend(t(`chat.quick.${key}`))}
                  disabled={sendMutation.isPending}
                  accessibilityRole="button"
                  style={({pressed}) => [
                    styles.chip,
                    {
                      backgroundColor: theme.colors.surface,
                      borderColor: theme.colors.border,
                      borderRadius: theme.radii.pill,
                      paddingVertical: theme.spacing.xs,
                      paddingHorizontal: theme.spacing.md,
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}>
                  <Text variant="footnote" color="inkMuted">
                    {t(`chat.quick.${key}`)}
                  </Text>
                </Pressable>
              ))}
            </View>

            {sendMutation.isError ? (
              <Banner tone="danger" title={t('chat.sendError')} />
            ) : null}

            <View style={[styles.inputRow, {gap: theme.spacing.sm}]}>
              <View style={styles.flex}>
                <TextField
                  label={t('chat.title')}
                  hideLabel
                  placeholder={t('chat.inputPlaceholder')}
                  value={draft}
                  onChangeText={setDraft}
                  multiline
                  returnKeyType="send"
                  blurOnSubmit={false}
                  onSubmitEditing={() => onSend(draft)}
                />
              </View>
              {/* Botón enviar: círculo VERDE (success) que se ACTIVA solo cuando hay texto; deshabilitado
                  queda gris (recesado) — señal clara de "escribí algo para enviar" (mejor feedback). */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('chat.send')}
                accessibilityState={{disabled: !canSend}}
                disabled={!canSend}
                onPress={() => onSend(draft)}
                style={({pressed}) => [
                  styles.sendBtn,
                  {
                    backgroundColor: canSend
                      ? theme.colors.success
                      : theme.colors.surfaceMuted,
                    opacity: pressed && canSend ? 0.85 : 1,
                  },
                ]}>
                <IconArrowRight
                  color={canSend ? theme.colors.onSuccess : theme.colors.inkSubtle}
                  size={22}
                />
              </Pressable>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1},
  empty: {flex: 1, justifyContent: 'center', alignItems: 'center'},
  // Separador de fecha entre días distintos (pen hPrJt DayDivider): centrado, con un respiro extra.
  dayDivider: {alignItems: 'center', paddingVertical: 2},
  composer: {borderTopWidth: StyleSheet.hairlineWidth},
  quickRow: {flexDirection: 'row', flexWrap: 'wrap'},
  chip: {borderWidth: StyleSheet.hairlineWidth},
  inputRow: {flexDirection: 'row', alignItems: 'flex-end'},
  sendBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
