import React, {useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {Banner, Button, SafeScreen, Skeleton, Text, useTheme} from '@veo/ui-kit';
import type {RootStackParamList} from '../../../../navigation/types';
import {TopBar} from '../../../../shared/presentation/components/TopBar';
import {toErrorMessage} from '../../../../shared/presentation/errors';
import {IconLifebuoy} from '../../../../shared/presentation/icons';
import type {TicketDraft} from '../../domain';
import {useCreateTicket, useTickets} from '../hooks/useSupport';
import {FaqAccordion} from '../components/FaqAccordion';
import {TicketRow} from '../components/TicketRow';
import {ReportProblemSheet} from '../components/ReportProblemSheet';
import {Appear} from '../components/motion';

type Props = NativeStackScreenProps<RootStackParamList, 'Support'>;

/**
 * Centro de ayuda del conductor: FAQ estático (cómo iniciar turno, pagos, documentos…), CTA
 * "Reportar un problema" (abre el formulario de ticket) y la lista "Mis tickets" con su estado.
 * Accesible desde Perfil. Si se llega con `tripId` (p. ej. desde un viaje), el formulario ofrece
 * adjuntarlo.
 */
export const SupportScreen = ({navigation, route}: Props): React.JSX.Element => {
  const {t} = useTranslation();
  const theme = useTheme();
  const tripId = route.params?.tripId;
  const tickets = useTickets();
  const createTicket = useCreateTicket();
  const [formOpen, setFormOpen] = useState(false);

  const submit = (draft: TicketDraft) => {
    createTicket.mutate(draft, {
      onSuccess: () => setFormOpen(false),
    });
  };

  return (
    <SafeScreen scroll header={<TopBar title={t('support.title')} onBack={navigation.goBack} />}>
      <View style={[styles.body, {gap: theme.spacing.xl, paddingBottom: theme.spacing['3xl']}]}>
        {/* Hero: invitación a reportar un problema. */}
        <Appear
          style={[
            styles.hero,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.xl,
              padding: theme.spacing['2xl'],
              gap: theme.spacing.lg,
            },
          ]}>
          <View style={styles.heroHead}>
            <View style={[styles.heroIcon, {backgroundColor: theme.colors.bg, borderRadius: theme.radii.md}]}>
              <IconLifebuoy size={24} color={theme.colors.accent} />
            </View>
            <View style={styles.flex}>
              <Text variant="headline">{t('support.heroTitle')}</Text>
              <Text variant="footnote" color="inkMuted">
                {t('support.heroBody')}
              </Text>
            </View>
          </View>
          <Button
            label={t('support.reportProblem')}
            variant="accent"
            fullWidth
            onPress={() => setFormOpen(true)}
          />
        </Appear>

        {/* FAQ estático. */}
        <Appear style={styles.section} delay={60}>
          <Text variant="subhead" color="inkMuted" style={styles.sectionLabel}>
            {t('support.faqTitle')}
          </Text>
          <FaqAccordion />
        </Appear>

        {/* Mis tickets. */}
        <Appear style={styles.section} delay={120}>
          <Text variant="subhead" color="inkMuted" style={styles.sectionLabel}>
            {t('support.myTickets')}
          </Text>
          {tickets.isLoading ? (
            <Skeleton height={120} radius={theme.radii.lg} />
          ) : tickets.isError || !tickets.data ? (
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(tickets.error, t)}
              action={{label: t('common.retry'), onPress: () => tickets.refetch()}}
            />
          ) : tickets.data.length === 0 ? (
            <View
              style={[
                styles.emptyCard,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radii.lg,
                  padding: theme.spacing['2xl'],
                },
              ]}>
              <Text variant="callout" color="inkMuted">
                {t('support.ticketsEmpty')}
              </Text>
            </View>
          ) : (
            <View
              style={[
                styles.ticketsCard,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radii.lg,
                  paddingHorizontal: theme.spacing.lg,
                },
              ]}>
              {tickets.data.map((ticket, index) => (
                <Appear key={ticket.id} delay={index * 50} distance={8}>
                  <TicketRow ticket={ticket} showDivider={index > 0} />
                </Appear>
              ))}
            </View>
          )}
        </Appear>
      </View>

      <ReportProblemSheet
        visible={formOpen}
        onClose={() => setFormOpen(false)}
        tripId={tripId}
        onSubmit={submit}
        submitting={createTicket.isPending}
      />
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  body: {paddingTop: 8},
  flex: {flex: 1, gap: 2},
  hero: {borderWidth: StyleSheet.hairlineWidth},
  heroHead: {flexDirection: 'row', alignItems: 'center', gap: 12},
  heroIcon: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  section: {},
  sectionLabel: {marginBottom: 8},
  ticketsCard: {borderWidth: StyleSheet.hairlineWidth},
  emptyCard: {borderWidth: StyleSheet.hairlineWidth},
});
