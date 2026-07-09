import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  type ListRenderItemInfo,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, IconButton, SafeScreen, Skeleton, useTheme } from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { IconNavigation } from '../../../../shared/presentation/icons';
import { isTripActive, parseTripStatus } from '../../../trips/domain';
import { useTrip } from '../../../trips/presentation/hooks/useTrips';
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
  const listRef = useRef<FlatList<Message>>(null);

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

  // Cada mensaje nuevo nos lleva al pie de la conversación (lo más reciente, abajo).
  useEffect(() => {
    if (messages.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [messages.length]);

  const quickReplies = useMemo(
    () => [t('chat.templates.arriving'), t('chat.templates.arrived'), t('chat.templates.waiting')],
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
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 8}
      >
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
            ref={listRef}
            data={messages}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="interactive"
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
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

        {active ? (
          <QuickReplies replies={quickReplies} onSelect={submit} disabled={send.isPending} />
        ) : null}

        <View
          style={[
            styles.composer,
            {
              backgroundColor: theme.colors.bg,
              borderTopColor: theme.colors.border,
              paddingBottom: insets.bottom + 8,
            },
          ]}
        >
          <View
            style={[
              styles.inputWrap,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.xl,
              },
            ]}
          >
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
          </View>
          <IconButton
            icon={
              <IconNavigation
                size={22}
                color={canSend ? theme.colors.onAccent : theme.colors.inkSubtle}
              />
            }
            accessibilityLabel={t('chat.send')}
            variant={canSend ? 'tinted' : 'surface'}
            size="lg"
            disabled={!canSend}
            onPress={() => submit(draft)}
          />
        </View>
      </KeyboardAvoidingView>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerPad: { paddingHorizontal: 20 },
  skeletonGap: { height: 12 },
  loading: { flex: 1, gap: 10, paddingHorizontal: 16, paddingTop: 16 },
  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  bannerPad: { paddingHorizontal: 16, paddingTop: 8 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  inputWrap: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  input: { fontSize: 16, maxHeight: 120, minHeight: 36, paddingTop: 6, paddingBottom: 6 },
});
