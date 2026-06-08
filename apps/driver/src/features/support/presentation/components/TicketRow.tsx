import React from 'react';
import {StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {StatusPill, Text, useTheme} from '@veo/ui-kit';
import {formatShortDate} from '../../../../shared/presentation/format';
import {
  supportCategoryI18nKey,
  supportStatusI18nKey,
  supportStatusTone,
  type SupportTicketView,
} from '../../domain';

export interface TicketRowProps {
  ticket: SupportTicketView;
  showDivider: boolean;
}

/**
 * Fila de un ticket de soporte: asunto + categoría/fecha + chip de estado. Densa pero legible.
 */
export function TicketRow({ticket, showDivider}: TicketRowProps): React.JSX.Element {
  const {t} = useTranslation();
  const theme = useTheme();

  return (
    <View
      style={[
        styles.row,
        {paddingVertical: theme.spacing.lg, gap: theme.spacing.md},
        showDivider && {borderTopColor: theme.colors.border, borderTopWidth: StyleSheet.hairlineWidth},
      ]}>
      <View style={styles.flex}>
        <Text variant="callout" numberOfLines={1}>
          {ticket.subject}
        </Text>
        <Text variant="footnote" color="inkMuted" numberOfLines={1}>
          {`${t(supportCategoryI18nKey(ticket.category))} · ${formatShortDate(ticket.createdAt)}`}
        </Text>
      </View>
      <StatusPill
        label={t(supportStatusI18nKey(ticket.status))}
        tone={supportStatusTone(ticket.status)}
        dot
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center'},
  flex: {flex: 1, gap: 2},
});
