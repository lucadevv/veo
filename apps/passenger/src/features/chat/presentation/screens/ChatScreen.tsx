import type {ChatMessage} from '@veo/api-client';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import {useMutation, useQuery} from '@tanstack/react-query';
import {
  Banner,
  SafeScreen,
  Text,
  useKeyboardHeight,
  useTheme,
} from '@veo/ui-kit';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
  FlatList,
  Pressable,
  StyleSheet,
  TextInput,
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
import {IconArrowRightLong} from '../../../trip/presentation/components/icons';

type Params = RouteProp<RootStackParamList, 'Chat'>;

/** Plantillas rápidas (claves i18n) para coordinar el recojo con un toque. SOLO 2 (regla del
 *  dueño): las más coherentes para el pasajero — "ya salgo" y "estoy en la puerta". */
const QUICK_REPLY_KEYS = ['leaving', 'atDoor'] as const;

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
  const keyboardHeight = useKeyboardHeight();
  const {params} = useRoute<Params>();
  const {tripId, driverName} = params;
  const navigation = useNavigation();

  // Título = primer nombre del conductor (simétrico al conductor, que muestra el del pasajero); genérico
  // si aún no se resolvió. El header lo centra (RN iOS). Unifica el título de chat entre ambas apps.
  useEffect(() => {
    navigation.setOptions({title: driverName ?? t('chat.title')});
  }, [navigation, driverName, t]);

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

  // Lista INVERTIDA (patrón chat): el offset 0 es el PIE de la conversación, así el último mensaje
  // (enviado o entrante) queda SIEMPRE a la vista — al llegar uno nuevo, al abrir el teclado (la
  // lista se encoge anclada abajo) y al entrar. Reemplaza al scrollToEnd imperativo, que corría a
  // destiempo del layout. `inverted` pinta los ítems al revés → se le da la data REVERSA (el orden
  // visual queda idéntico: viejo arriba, nuevo abajo).
  const invertedItems = useMemo(() => [...listItems].reverse(), [listItems]);

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
      {/* El padding inferior = alto EXACTO del teclado (ventana): composer siempre COMPLETO encima. */}
      <View style={[styles.flex, {paddingBottom: keyboardHeight}]}>
        <FlatList
          style={styles.flex}
          data={invertedItems}
          keyExtractor={item =>
            item.kind === 'divider' ? item.id : item.message.id
          }
          renderItem={renderItem}
          // Anclada al pie SOLO con mensajes: invertida, el vacío quedaría patas arriba (los hijos
          // de una lista `inverted` se pintan espejados) — sin ítems se pinta normal.
          inverted={listItems.length > 0}
          keyboardDismissMode="interactive"
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
                // Con el teclado abierto el home indicator queda tapado → su inset sobraría como
                // hueco muerto entre composer y teclado; se paga solo con el teclado cerrado.
                paddingBottom:
                  (keyboardHeight > 0 ? 0 : insets.bottom) + theme.spacing.md,
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

            {sendMutation.isError ? (
              <Banner tone="danger" title={t('chat.sendError')} />
            ) : null}

            {/* UN solo contenedor (regla del dueño): las plantillas rápidas + el input + enviar viven
                dentro de la MISMA card — antes los chips flotaban sueltos arriba del input. */}
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
              ]}>
              <View style={[styles.quickRow, {gap: theme.spacing.xs}]}>
                {QUICK_REPLY_KEYS.map(key => (
                  <Pressable
                    key={key}
                    onPress={() => onSend(t(`chat.quick.${key}`))}
                    disabled={sendMutation.isPending}
                    accessibilityRole="button"
                    style={({pressed}) => [
                      {
                        // Sobre la card `surface`, el chip se recesa con `surfaceMuted` (sin borde):
                        // un contenedor bordeado dentro de otro se leía como dos cajas sueltas.
                        backgroundColor: theme.colors.surfaceMuted,
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

              <View style={[styles.inputRow, {gap: theme.spacing.sm}]}>
                {/* Input DESNUDO (sin su propia caja): la card ya es el contenedor visual. */}
                <TextInput
                  style={[styles.input, {color: theme.colors.ink}]}
                  placeholder={t('chat.inputPlaceholder')}
                  placeholderTextColor={theme.colors.inkSubtle}
                  value={draft}
                  onChangeText={setDraft}
                  multiline
                  returnKeyType="send"
                  blurOnSubmit={false}
                  // Sin autofill: la barra "Autorrellenar" de iOS se sumaba ARRIBA del teclado y comía el
                  // espacio del composer (el input quedaba tapado). No aplica a un chat.
                  autoComplete="off"
                  textContentType="none"
                  onSubmitEditing={() => onSend(draft)}
                  accessibilityLabel={t('chat.inputPlaceholder')}
                />
                {/* Botón enviar: círculo VERDE (accentStrong) + flecha → COMPLETA (asta + punta), se
                    ACTIVA solo cuando hay texto; deshabilitado queda gris (recesado). */}
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
                        ? theme.colors.accentStrong
                        : theme.colors.surfaceMuted,
                      opacity: pressed && canSend ? 0.85 : 1,
                    },
                  ]}>
                  <IconArrowRightLong
                    color={canSend ? theme.colors.onBrand : theme.colors.inkSubtle}
                    size={22}
                  />
                </Pressable>
              </View>
            </View>
          </View>
        )}
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  flex: {flex: 1},
  empty: {flex: 1, justifyContent: 'center', alignItems: 'center'},
  // Separador de fecha entre días distintos (pen hPrJt DayDivider): centrado, con un respiro extra.
  dayDivider: {alignItems: 'center', paddingVertical: 2},
  composer: {borderTopWidth: StyleSheet.hairlineWidth},
  composerCard: {borderWidth: StyleSheet.hairlineWidth},
  quickRow: {flexDirection: 'row', flexWrap: 'wrap'},
  inputRow: {flexDirection: 'row', alignItems: 'flex-end'},
  input: {flex: 1, fontSize: 16, maxHeight: 120, minHeight: 44, paddingTop: 12, paddingBottom: 12},
  sendBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
