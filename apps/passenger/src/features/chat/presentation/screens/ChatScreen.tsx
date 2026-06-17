import type {ChatMessage} from '@veo/api-client';
import {useRoute, type RouteProp} from '@react-navigation/native';
import {useMutation, useQuery} from '@tanstack/react-query';
import {
  Banner,
  IconButton,
  SafeScreen,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
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
import {usePassengerTripSocket} from '../../../trip/presentation/hooks/usePassengerTripSocket';
import {isChatActive, mergeMessages} from '../../domain/entities';
import {MessageBubble} from '../components/MessageBubble';

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
  const [draft, setDraft] = useState('');
  const listRef = useRef<FlatList<ChatMessage>>(null);

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

  // Lista única y estable: historial + enviados + entrantes del socket, deduplicados y ordenados.
  const messages = useMemo(
    () =>
      mergeMessages(historyQuery.data ?? [], [
        ...sentMessages,
        ...live.incomingMessages,
      ]),
    [historyQuery.data, sentMessages, live.incomingMessages],
  );

  // Drena los entrantes ya integrados para no reprocesarlos y mantener limpio el badge de no leídos.
  useEffect(() => {
    if (live.incomingMessages.length > 0) {
      acknowledgeMessages(live.incomingMessages.map(message => message.id));
    }
  }, [live.incomingMessages, acknowledgeMessages]);

  // Autoscroll al final cuando llega/sale un mensaje (ease del propio FlatList; respeta el sistema).
  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({animated: true});
    }
  }, [messages.length]);

  const liveStatusKnown = live.status !== null || live.ended;
  const active = liveStatusKnown
    ? isChatActive(live.ended ? 'COMPLETED' : live.status)
    : true;

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

  const renderItem = useCallback(
    ({item}: {item: ChatMessage}) => <MessageBubble message={item} />,
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
          data={messages}
          keyExtractor={item => item.id}
          renderItem={renderItem}
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
                  placeholder={t('chat.inputPlaceholder')}
                  value={draft}
                  onChangeText={setDraft}
                  multiline
                  returnKeyType="send"
                  blurOnSubmit={false}
                  onSubmitEditing={() => onSend(draft)}
                />
              </View>
              <IconButton
                accessibilityLabel={t('chat.send')}
                variant="tinted"
                size="lg"
                disabled={draft.trim().length === 0 || sendMutation.isPending}
                onPress={() => onSend(draft)}
                icon={
                  <Text variant="bodyStrong" color="onAccent">
                    ↑
                  </Text>
                }
              />
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
  composer: {borderTopWidth: StyleSheet.hairlineWidth},
  quickRow: {flexDirection: 'row', flexWrap: 'wrap'},
  chip: {borderWidth: StyleSheet.hairlineWidth},
  inputRow: {flexDirection: 'row', alignItems: 'flex-end'},
});
