import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Avatar, Card, Text, useTheme } from '@veo/ui-kit';
import { IconCheck, IconStar } from '../../../../shared/presentation/icons';

export interface ProfileIdentityCardProps {
  /** Nombre/teléfono mostrado como identidad principal. */
  name: string;
  /** Anillo "en línea" en el avatar (conductor disponible). */
  online: boolean;
  /** Rating formateado (ej. "4.9"). */
  ratingValue: string;
  /** Metadato secundario opcional (ej. "120 viajes (30 días)"). */
  ratingMeta?: string;
  /** Cuenta verificada (KYC aprobado): muestra un check JADE sutil junto al nombre (verificación
   *  sutil, un solo acento premium — NO un checklist de badges). */
  verified?: boolean;
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
  verified = false,
}: ProfileIdentityCardProps): React.JSX.Element => {
  const theme = useTheme();

  return (
    <Card variant="filled">
      <View style={styles.row}>
        <Avatar name={name} size="xl" online={online} />
        <View style={styles.info}>
          <View style={styles.nameRow}>
            <Text variant="title3" numberOfLines={1} style={styles.nameText}>
              {name}
            </Text>
            {verified ? (
              <IconCheck size={16} color={theme.colors.success} strokeWidth={2.8} />
            ) : null}
          </View>

          <View style={styles.metaRow}>
            <View style={styles.ratingChip}>
              <IconStar size={15} color={theme.colors.warn} filled strokeWidth={1.5} />
              <Text variant="bodyStrong" color="ink" tabular>
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
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  nameText: { flexShrink: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  ratingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  meta: { flexShrink: 1 },
});
