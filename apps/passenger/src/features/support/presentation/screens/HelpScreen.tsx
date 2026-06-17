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
import {Pressable, ScrollView, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {formatShortDate} from '../../../../shared/utils/format';
import {SUPPORT_CATEGORIES} from '../../domain/entities';
import {
  TicketValidationError,
  ticketStatusTone,
  type TicketField,
} from '../../domain/usecases';
import {FaqItem} from '../components/FaqItem';

/** Claves de la FAQ estática del pasajero (texto en i18n). El orden es el de visualización. */
const FAQ_KEYS = [
  'requestRide',
  'payment',
  'safety',
  'privacy',
  'cancellation',
] as const;

/**
 * Centro de Ayuda del pasajero. Tres bloques: FAQ estática (acordeón), "Reportar un problema"
 * (POST /support/tickets) y "Mis solicitudes" (GET /support/tickets). El BFF fija userId/role
 * desde la identidad; la app solo manda categoría, asunto, cuerpo y, opcional, el tripId reciente.
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

  const [expandedFaq, setExpandedFaq] = useState<string | null>(null);

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
        showsVerticalScrollIndicator={false}>
        {/* FAQ estática */}
        <View>
          <Text
            variant="subhead"
            color="inkMuted"
            style={{marginBottom: theme.spacing.sm}}>
            {t('support.faqTitle')}
          </Text>
          <Card variant="outlined" padding="md">
            {FAQ_KEYS.map(key => (
              <FaqItem
                key={key}
                question={t(`support.faq.${key}.q` as const)}
                answer={t(`support.faq.${key}.a` as const)}
                expanded={expandedFaq === key}
                onToggle={() =>
                  setExpandedFaq(current => (current === key ? null : key))
                }
              />
            ))}
          </Card>
        </View>

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

const styles = StyleSheet.create({
  categoryRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
