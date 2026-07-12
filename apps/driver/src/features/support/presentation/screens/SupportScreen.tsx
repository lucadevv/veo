import React, { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  Banner,
  BottomSheet,
  hexAlpha,
  IconButton,
  SafeScreen,
  Skeleton,
  Text,
  useTheme,
} from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import {
  IconChevronRight,
  IconHeadset,
  IconMore,
  IconSearch,
} from '../../../../shared/presentation/icons';
import type { TicketDraft } from '../../domain';
import { useCreateTicket, useTickets } from '../hooks/useSupport';
import { FaqTopics, filterFaqTopics } from '../components/FaqTopics';
import { TicketRow } from '../components/TicketRow';
import { ReportProblemSheet } from '../components/ReportProblemSheet';
import { Reveal } from '../../../../shared/presentation/components/motion';

type Props = NativeStackScreenProps<RootStackParamList, 'Support'>;

/**
 * Centro de ayuda del conductor (frame `C/Ayuda`): buscador + "Temas frecuentes" (FAQ tappable que
 * expande la respuesta) + card "Chatear con soporte". El chat se resuelve como ticket contra el
 * driver-bff (`/support/tickets`, el único seam de soporte): la card abre el `ReportProblemSheet`.
 * "Mis tickets" queda accesible desde el ⋯ del header. Cuatro estados en cada vista (carga/vacío/
 * error/lista) y filtro de FAQ client-side (4 temas → instantáneo, sin fetch por tecla).
 */
export const SupportScreen = ({ navigation, route }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const tripId = route.params?.tripId;
  const tickets = useTickets();
  const createTicket = useCreateTicket();
  const [formOpen, setFormOpen] = useState(false);
  const [ticketsOpen, setTicketsOpen] = useState(false);
  const [query, setQuery] = useState('');

  const submit = (draft: TicketDraft) => {
    createTicket.mutate(draft, { onSuccess: () => setFormOpen(false) });
  };

  const noMatches = filterFaqTopics(query, t).length === 0;

  const header = (
    <TopBar
      title={t('support.title')}
      onBack={navigation.goBack}
      trailing={
        <IconButton
          accessibilityLabel={t('support.myTickets')}
          variant="surface"
          icon={<IconMore size={20} color={theme.colors.ink} />}
          onPress={() => setTicketsOpen(true)}
        />
      }
    />
  );

  return (
    <SafeScreen scroll header={header}>
      <View style={[styles.body, { gap: theme.spacing.xl, paddingBottom: theme.spacing['3xl'] }]}>
        {/* Buscador: filtra los temas frecuentes (client-side). */}
        <View
          style={[
            styles.search,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderColor: theme.colors.border,
              borderRadius: theme.radii.md,
              paddingHorizontal: theme.spacing.lg,
              gap: theme.spacing.sm,
            },
          ]}
        >
          <IconSearch size={20} color={theme.colors.inkSubtle} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('support.searchPlaceholder')}
            placeholderTextColor={theme.colors.inkSubtle}
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel={t('support.searchPlaceholder')}
            style={[styles.searchInput, { color: theme.colors.ink }]}
          />
        </View>

        {/* Temas frecuentes. */}
        <Reveal style={styles.section} delay={40}>
          <Text variant="subhead" color="inkMuted" style={styles.sectionLabel}>
            {t('support.faqTitle')}
          </Text>
          {noMatches ? (
            <Banner tone="info" title={t('support.searchEmpty')} />
          ) : (
            <FaqTopics query={query} />
          )}
        </Reveal>

        {/* Chatear con soporte → abre el formulario de ticket (/support/tickets). */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('support.chatTitle')}
          onPress={() => setFormOpen(true)}
          style={({ pressed }) => [
            styles.chatCard,
            {
              backgroundColor: hexAlpha(theme.colors.accent, 0.12),
              borderColor: theme.colors.accent,
              borderRadius: theme.radii.xl,
              padding: theme.spacing.xl,
              gap: theme.spacing.md,
              opacity: pressed ? 0.92 : 1,
            },
          ]}
        >
          <View
            style={[
              styles.chatIcon,
              // Disco blanco sobre la card tintada de acento (frame C/Ayuda: CIc #FFFFFF, ícono accent).
              { backgroundColor: theme.colors.surface, borderRadius: theme.radii.pill },
            ]}
          >
            <IconHeadset size={22} color={theme.colors.accent} />
          </View>
          <View style={styles.flex}>
            <Text variant="bodyStrong">{t('support.chatTitle')}</Text>
            <Text variant="footnote" color="inkMuted">
              {t('support.chatSubtitle')}
            </Text>
          </View>
          <IconChevronRight size={20} color={theme.colors.accent} />
        </Pressable>
      </View>

      {/* Sheet del ticket (lo abre "Chatear con soporte"). */}
      <ReportProblemSheet
        visible={formOpen}
        onClose={() => setFormOpen(false)}
        tripId={tripId}
        onSubmit={submit}
        submitting={createTicket.isPending}
      />

      {/* Sheet "Mis tickets" (desde el ⋯). Cuatro estados. */}
      <BottomSheet
        visible={ticketsOpen}
        onClose={() => setTicketsOpen(false)}
        title={t('support.myTickets')}
      >
        {tickets.isLoading ? (
          <Skeleton height={120} radius={theme.radii.lg} />
        ) : tickets.isError || !tickets.data ? (
          <Banner
            tone="danger"
            title={t('errors.generic')}
            description={toErrorMessage(tickets.error, t)}
            action={{ label: t('common.retry'), onPress: () => tickets.refetch() }}
          />
        ) : tickets.data.length === 0 ? (
          <Text variant="callout" color="inkMuted">
            {t('support.ticketsEmpty')}
          </Text>
        ) : (
          <View>
            {tickets.data.map((ticket, index) => (
              <TicketRow key={ticket.id} ticket={ticket} showDivider={index > 0} />
            ))}
          </View>
        )}
      </BottomSheet>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  body: { paddingTop: 8 },
  flex: { flex: 1, gap: 2 },
  search: { flexDirection: 'row', alignItems: 'center', height: 50, borderWidth: StyleSheet.hairlineWidth },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 0 },
  section: {},
  sectionLabel: { marginBottom: 8 },
  chatCard: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth },
  chatIcon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
