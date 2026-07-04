import type {
  SupportCategory,
  SupportTicket,
  TripResource,
} from '@veo/api-client';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Banner,
  BottomSheet,
  Button,
  Card,
  ListItem,
  SafeScreen,
  StatusPill,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {ScreenHeader} from '../../../../shared/presentation/components/ScreenHeader';
import {formatShortDate} from '../../../../shared/utils/format';
import {SUPPORT_CATEGORIES} from '../../domain/entities';
import {
  TicketValidationError,
  ticketStatusTone,
  type TicketField,
} from '../../domain/usecases';
import {FaqItem} from '../components/FaqItem';
import type {GlyphProps} from '../components/icons';
import {
  IconCarFront,
  IconSearch,
  IconShield,
  IconUser,
  IconWallet,
} from '../components/icons';

/** Claves de la FAQ estática del pasajero (texto en i18n). */
const FAQ_KEYS = [
  'requestRide',
  'payment',
  'safety',
  'privacy',
  'cancellation',
] as const;

type FaqKey = (typeof FAQ_KEYS)[number];

/**
 * TEMAS del pen P/Help ("Temas frecuentes"): 4 filas navegables con icono + chevron que expanden
 * el grupo (accordion). Las preguntas EXISTENTES se mapean al tema que les corresponde:
 * viaje → pedir/cancelar; pagos → métodos de pago; seguridad → botón de emergencia;
 * cuenta → datos personales (Ley 29733).
 */
const TOPICS = [
  {key: 'trip', Icon: IconCarFront, faqKeys: ['requestRide', 'cancellation']},
  {key: 'payments', Icon: IconWallet, faqKeys: ['payment']},
  {key: 'safety', Icon: IconShield, faqKeys: ['safety']},
  {key: 'account', Icon: IconUser, faqKeys: ['privacy']},
] as const;

type TopicKey = (typeof TOPICS)[number]['key'];

/** Normaliza para buscar: minúsculas y sin acentos (así "pánico" matchea "panico"). */
function normalizeForSearch(value: string): string {
  // NFD separa la letra base de su diacrítico; el rango U+0300–U+036F son los diacríticos sueltos.
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Centro de Ayuda del pasajero (design/veo.pen P/Help). Bloques: header in-body (título +
 * subtítulo), BUSCADOR que filtra la FAQ en vivo, "Temas frecuentes" (4 temas accordion),
 * "Mis solicitudes" (GET /support/tickets) y el CTA "Reportar un problema" (POST /support/tickets).
 * El BFF fija userId/role desde la identidad; la app solo manda categoría, asunto, cuerpo y,
 * opcional, el tripId reciente.
 */
export function HelpScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const queryClient = useQueryClient();

  const createTicket = useDependency(TOKENS.createTicketUseCase);
  const listTickets = useDependency(TOKENS.listTicketsUseCase);
  const history = useDependency(TOKENS.tripHistoryRepository);

  const ticketsQuery = useQuery({
    queryKey: ['support', 'tickets'],
    queryFn: () => listTickets.execute(),
  });

  // Viaje más reciente conocido por el dispositivo (historial local): adjuntable al ticket.
  const recentTrip: TripResource | undefined = useMemo(
    () => history.list()[0],
    [history],
  );

  const [query, setQuery] = useState('');
  const [expandedTopic, setExpandedTopic] = useState<TopicKey | null>(null);
  const [expandedFaq, setExpandedFaq] = useState<string | null>(null);

  // BÚSQUEDA en vivo sobre pregunta + respuesta, case/acentos-insensitive. Con query activa se
  // muestran las preguntas que matchean DIRECTAMENTE (sin pasar por los temas), per instrucción.
  const normalizedQuery = normalizeForSearch(query.trim());
  const matchingFaqKeys: FaqKey[] =
    normalizedQuery.length === 0
      ? []
      : FAQ_KEYS.filter(key => {
          const haystack = normalizeForSearch(
            `${t(`support.faq.${key}.q` as const)} ${t(`support.faq.${key}.a` as const)}`,
          );
          return haystack.includes(normalizedQuery);
        });
  const searching = normalizedQuery.length > 0;

  const toggleTopic = (key: TopicKey): void => {
    LayoutAnimation.configureNext(
      LayoutAnimation.create(160, 'easeInEaseOut', 'opacity'),
    );
    setExpandedTopic(current => (current === key ? null : key));
    // Al cerrar/cambiar de tema, la pregunta abierta deja de tener contexto: se colapsa.
    setExpandedFaq(null);
  };

  const [reportOpen, setReportOpen] = useState(false);
  const [category, setCategory] = useState<SupportCategory>('TRIP');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachTrip, setAttachTrip] = useState(false);
  const [fieldError, setFieldError] = useState<TicketField | null>(null);

  const resetForm = () => {
    setCategory('TRIP');
    setSubject('');
    setBody('');
    setAttachTrip(false);
    setFieldError(null);
  };

  const createMutation = useMutation<SupportTicket, Error, void>({
    mutationFn: () =>
      createTicket.execute({
        category,
        subject,
        body,
        ...(attachTrip && recentTrip ? {tripId: recentTrip.id} : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({queryKey: ['support', 'tickets']});
    },
    onError: error => {
      if (error instanceof TicketValidationError) {
        setFieldError(error.field);
      }
    },
  });

  const closeReport = () => {
    setReportOpen(false);
    createMutation.reset();
    resetForm();
  };

  const tickets = ticketsQuery.data ?? [];

  const renderFaqItem = (key: FaqKey): React.JSX.Element => (
    <FaqItem
      key={key}
      question={t(`support.faq.${key}.q` as const)}
      answer={t(`support.faq.${key}.a` as const)}
      expanded={expandedFaq === key}
      onToggle={() =>
        setExpandedFaq(current => (current === key ? null : key))
      }
    />
  );

  return (
    <SafeScreen
      padded={false}
      footer={
        <Button
          label={t('support.reportCta')}
          fullWidth
          onPress={() => {
            createMutation.reset();
            resetForm();
            setReportOpen(true);
          }}
        />
      }>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {/* Header in-body per pen (back pill + título display + subtítulo cálido). */}
        <ScreenHeader
          title={t('support.title')}
          subtitle={t('support.subtitle')}
        />

        {/* Buscador per pen (icono search en color de marca + placeholder). El ui-kit no tiene un
            input de búsqueda editable (TextField exige label visible y SearchField es presentacional),
            así que la fila se compone acá con tokens del tema — nada hardcodeado. */}
        <View
          style={[
            styles.searchBar,
            {
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radii.lg,
              borderColor: theme.colors.border,
              paddingHorizontal: theme.spacing.lg,
              gap: theme.spacing.md,
            },
          ]}>
          <IconSearch color={theme.colors.accent} size={20} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('support.searchPlaceholder')}
            placeholderTextColor={theme.colors.inkSubtle}
            accessibilityLabel={t('support.searchPlaceholder')}
            autoCorrect={false}
            returnKeyType="search"
            style={[
              styles.searchInput,
              {
                // Rol `body` del tema (el pen usa 15px; el token más cercano de la escala es 16).
                fontFamily: theme.typography.text.body.fontFamily,
                fontSize: theme.typography.text.body.fontSize,
                color: theme.colors.ink,
              },
            ]}
          />
        </View>

        {searching ? (
          /* Búsqueda activa: preguntas que matchean, directas (sin agrupar por tema). */
          <View>
            <Text
              variant="subhead"
              color="inkMuted"
              style={{marginBottom: theme.spacing.sm}}>
              {t('support.searchResultsTitle')}
            </Text>
            {matchingFaqKeys.length > 0 ? (
              <Card variant="outlined" padding="md">
                {matchingFaqKeys.map(renderFaqItem)}
              </Card>
            ) : (
              /* Sin resultados: texto honesto, con el camino real (reportar el problema). */
              <Card variant="outlined" padding="md">
                <EmptyState
                  title={t('support.searchNoResults', {query: query.trim()})}
                  subtitle={t('support.searchNoResultsHint')}
                />
              </Card>
            )}
          </View>
        ) : (
          /* Temas frecuentes per pen: 4 filas con icono + chevron que expanden su grupo. */
          <View>
            <Text
              variant="subhead"
              color="inkMuted"
              style={{marginBottom: theme.spacing.sm}}>
              {t('support.topicsTitle')}
            </Text>
            <Card variant="outlined" padding="none">
              {TOPICS.map((topic, index) => {
                const expanded = expandedTopic === topic.key;
                return (
                  <View key={topic.key}>
                    {index > 0 ? (
                      <View style={styles.dividerWrap}>
                        <View
                          style={[
                            styles.divider,
                            {backgroundColor: theme.colors.border},
                          ]}
                        />
                      </View>
                    ) : null}
                    <TopicRow
                      Icon={topic.Icon}
                      title={t(`support.topics.${topic.key}` as const)}
                      expanded={expanded}
                      onToggle={() => toggleTopic(topic.key)}
                    />
                    {expanded ? (
                      <View
                        style={{
                          paddingHorizontal: theme.spacing.lg,
                          paddingBottom: theme.spacing.sm,
                        }}>
                        {topic.faqKeys.map(renderFaqItem)}
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </Card>
          </View>
        )}

        {/* Mis solicitudes */}
        <View>
          <Text
            variant="subhead"
            color="inkMuted"
            style={{marginBottom: theme.spacing.sm}}>
            {t('support.myTicketsTitle')}
          </Text>

          {ticketsQuery.isLoading ? (
            <LoadingState lines={2} />
          ) : ticketsQuery.isError ? (
            <ErrorState onRetry={() => ticketsQuery.refetch()} />
          ) : tickets.length === 0 ? (
            <Card variant="outlined" padding="md">
              <EmptyState
                title={t('support.empty')}
                subtitle={t('support.emptySubtitle')}
              />
            </Card>
          ) : (
            <View style={{gap: theme.spacing.sm}}>
              {tickets.map(ticket => (
                <Card key={ticket.id} variant="outlined" padding="md">
                  <ListItem
                    title={ticket.subject}
                    subtitle={`${t(`support.category.${ticket.category}` as const)} · ${formatShortDate(ticket.createdAt)}`}
                    trailing={
                      <StatusPill
                        label={t(`support.status.${ticket.status}` as const)}
                        tone={ticketStatusTone(ticket.status)}
                        dot
                      />
                    }
                  />
                </Card>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Reportar un problema */}
      <BottomSheet
        visible={reportOpen}
        onClose={closeReport}
        title={t('support.reportTitle')}
        footer={
          createMutation.isSuccess ? (
            <Button
              label={t('actions.close')}
              fullWidth
              onPress={closeReport}
            />
          ) : (
            <Button
              label={t('support.submit')}
              fullWidth
              loading={createMutation.isPending}
              onPress={() => createMutation.mutate()}
            />
          )
        }>
        {createMutation.isSuccess ? (
          <Banner
            tone="success"
            title={t('support.sent')}
            description={t('support.sentBody')}
          />
        ) : (
          <View style={{gap: theme.spacing.lg}}>
            {createMutation.isError &&
            !(createMutation.error instanceof TicketValidationError) ? (
              <Banner tone="danger" title={t('support.sendError')} />
            ) : null}

            {/* Selector de categoría (chips etiquetados en español) */}
            <View style={{gap: theme.spacing.sm}}>
              <Text variant="footnote" color="inkMuted">
                {t('support.categoryLabel')}
              </Text>
              <View style={styles.categoryRow}>
                {SUPPORT_CATEGORIES.map(value => {
                  const selected = value === category;
                  return (
                    <Pressable
                      key={value}
                      onPress={() => setCategory(value)}
                      accessibilityRole="button"
                      accessibilityState={{selected}}
                      style={[
                        styles.chip,
                        {
                          borderRadius: theme.radii.pill,
                          borderColor: selected
                            ? theme.colors.accent
                            : theme.colors.border,
                          backgroundColor: selected
                            ? theme.colors.accent
                            : 'transparent',
                        },
                      ]}>
                      <Text
                        variant="footnote"
                        color={selected ? 'onAccent' : 'inkMuted'}>
                        {t(`support.category.${value}` as const)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <TextField
              label={t('support.subjectLabel')}
              placeholder={t('support.subjectPlaceholder')}
              value={subject}
              onChangeText={value => {
                setSubject(value);
                if (fieldError === 'subject') {
                  setFieldError(null);
                }
              }}
              maxLength={120}
              error={
                fieldError === 'subject'
                  ? t('support.invalidSubject')
                  : undefined
              }
            />

            <TextField
              label={t('support.bodyLabel')}
              placeholder={t('support.bodyPlaceholder')}
              value={body}
              onChangeText={value => {
                setBody(value);
                if (fieldError === 'body') {
                  setFieldError(null);
                }
              }}
              multiline
              maxLength={2000}
              error={
                fieldError === 'body' ? t('support.invalidBody') : undefined
              }
            />

            {/* Adjuntar viaje reciente (solo si hay historial) */}
            {recentTrip ? (
              <Pressable
                onPress={() => setAttachTrip(value => !value)}
                accessibilityRole="checkbox"
                accessibilityState={{checked: attachTrip}}>
                <Card variant={attachTrip ? 'filled' : 'outlined'} padding="md">
                  <ListItem
                    title={t('support.attachTrip')}
                    subtitle={t('support.attachTripDetail', {
                      date: formatShortDate(recentTrip.requestedAt),
                    })}
                    trailing={
                      <StatusPill
                        label={
                          attachTrip ? t('support.attached') : t('actions.add')
                        }
                        tone={attachTrip ? 'success' : 'neutral'}
                        dot={attachTrip}
                      />
                    }
                  />
                </Card>
              </Pressable>
            ) : null}
          </View>
        )}
      </BottomSheet>
    </SafeScreen>
  );
}

interface TopicRowProps {
  Icon: (props: GlyphProps) => React.JSX.Element;
  title: string;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Fila de tema per pen (icono 20 inkMuted + título + chevron, padding 16). El chevron rota a
 * "abierto" al expandir — mismo lenguaje del FaqItem: el color nunca es el único indicador.
 */
function TopicRow({
  Icon,
  title,
  expanded,
  onToggle,
}: TopicRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{expanded}}
      accessibilityLabel={title}
      style={({pressed}) => [
        styles.topicRow,
        {gap: theme.spacing.md},
        pressed ? {backgroundColor: theme.colors.surfaceElevated} : null,
      ]}>
      <Icon color={theme.colors.inkMuted} size={20} />
      <View style={styles.topicTitle}>
        <Text variant="bodyStrong">{title}</Text>
      </View>
      <Text
        variant="callout"
        color={expanded ? 'accent' : 'inkSubtle'}
        style={expanded ? styles.chevronOpen : styles.chevronClosed}>
        ›
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  // Altura cómoda de campo táctil (≥44pt) sin depender del padding vertical del contenido.
  searchInput: {flex: 1, paddingVertical: 14},
  topicRow: {flexDirection: 'row', alignItems: 'center', padding: 16},
  topicTitle: {flex: 1},
  chevronClosed: {transform: [{rotate: '0deg'}]},
  chevronOpen: {transform: [{rotate: '90deg'}]},
  dividerWrap: {paddingLeft: 52},
  divider: {height: StyleSheet.hairlineWidth},
  categoryRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
