import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Avatar, Card, Text, useTheme } from '@veo/ui-kit';
import { IconStar } from '../../../../shared/presentation/icons';

export interface ProfileIdentityCardProps {
  /** Nombre/teléfono mostrado como identidad principal. */
  name: string;
  /** Anillo "en línea" en el avatar (conductor disponible). */
  online: boolean;
  /** Rating formateado (ej. "4.9"). */
  ratingValue: string;
  /** Metadato secundario opcional (ej. "120 viajes (30 días)"). */
  ratingMeta?: string;
}

/**
 * Tarjeta de identidad premium del conductor: avatar grande, nombre y un chip de rating
 * (estrella + valor). Presentacional: recibe datos ya formateados de `useProfile`.
 */
export const ProfileIdentityCard = ({
  name,
  online,
  ratingValue,
  ratingMeta,
}: ProfileIdentityCardProps): React.JSX.Element => {
  const theme = useTheme();

  return (
    <Card variant="filled">
      <View style={styles.row}>
        <Avatar name={name} size="xl" online={online} />
        <View style={styles.info}>
          <Text variant="title3" numberOfLines={1}>
            {name}
          </Text>

          <View style={styles.metaRow}>
            <View
              style={[
                styles.ratingChip,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radii.pill,
                },
              ]}
            >
              <IconStar size={14} color={theme.colors.warn} filled strokeWidth={1.5} />
              <Text variant="label" color="ink" tabular>
                {ratingValue}
              </Text>
            </View>

            {ratingMeta ? (
              <Text variant="footnote" color="inkMuted" numberOfLines={1} style={styles.meta}>
                {ratingMeta}
              </Text>
            ) : null}
          </View>
        </View>
      </View>
    </Card>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  info: { flex: 1, gap: 8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  ratingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
  },
  meta: { flexShrink: 1 },
});
