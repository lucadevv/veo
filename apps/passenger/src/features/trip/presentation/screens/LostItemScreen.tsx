import { type RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { SupportTicket } from '@veo/api-client';
import { useMutation } from '@tanstack/react-query';
import { Banner, Button, Card, SafeScreen, Text, TextField, useTheme } from '@veo/ui-kit';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { TicketValidationError } from '../../../support/domain/usecases';
import type { RootStackParamList } from '../../../../navigation/types';
import { IconLock, IconShield } from '../components/icons';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Params = RouteProp<RootStackParamList, 'LostItem'>;

/** Claves i18n de los tipos de objeto sugeridos (chips). El orden es el de visualización. */
const ITEM_KEYS = ['phone', 'wallet', 'backpack', 'keys', 'other'] as const;
type ItemKey = (typeof ITEM_KEYS)[number];

/**
 * "Olvidé algo" (design-handoff "LostItem"), accesible desde el detalle de un viaje.
 *
 * BACKEND REAL: no hay un endpoint dedicado de "objeto perdido", pero sí el de SOPORTE
 * (POST /support/tickets). El reporte se crea como un ticket categoría DRIVER con el viaje adjunto
 * (tripId), de modo que VEO media el contacto con el conductor — coherente con la promesa del diseño
 * de mantener oculto el número del pasajero. Por seguridad NO se contacta al conductor directamente
 * desde aquí; el equipo de soporte gestiona el reporte.
 */
export function LostItemScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const { tripId } = useRoute<Params>().params;

  const createTicket = useDependency(TOKENS.createTicketUseCase);

  const [item, setItem] = useState<ItemKey>('phone');
  const [description, setDescription] = useState('');
  const [bodyError, setBodyError] = useState(false);

  const createMutation = useMutation<SupportTicket, Error, void>({
    mutationFn: () =>
      createTicket.execute({
        category: 'DRIVER',
        subject: t('lostItem.subject', { item: t(`lostItem.items.${item}`) }),
        body: description,
        tripId,
      }),
    onError: (error) => {
      if (error instanceof TicketValidationError) {
        setBodyError(true);
      }
    },
  });

  const sent = createMutation.isSuccess;

  return (
    <SafeScreen
      padded={false}
      footer={
        sent ? (
          <Button label={t('actions.close')} fullWidth onPress={() => navigation.goBack()} />
        ) : (
          <Button
            label={t('lostItem.submit')}
            fullWidth
            loading={createMutation.isPending}
            onPress={() => createMutation.mutate()}
          />
        )
      }
    >
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.xl, gap: theme.spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        {sent ? (
          <Banner tone="success" title={t('lostItem.sentTitle')} description={t('lostItem.sentBody')} />
        ) : (
          <>
            <Text variant="callout" color="inkMuted">
              {t('lostItem.intro')}
            </Text>

            {createMutation.isError && !(createMutation.error instanceof TicketValidationError) ? (
              <Banner tone="danger" title={t('lostItem.error')} />
            ) : null}

            {/* Tipo de objeto (chips). Estado por borde + fondo, no solo color. */}
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="footnote" color="inkMuted">
                {t('lostItem.whatLabel')}
              </Text>
              <View style={styles.chipRow}>
                {ITEM_KEYS.map((value) => {
                  const selected = value === item;
                  return (
                    <Pressable
                      key={value}
                      onPress={() => setItem(value)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      style={[
                        styles.chip,
                        {
                          borderRadius: theme.radii.pill,
                          borderColor: selected ? theme.colors.accent : theme.colors.border,
                          backgroundColor: selected ? theme.colors.accent : 'transparent',
                        },
                      ]}
                    >
                      <Text variant="footnote" color={selected ? 'onAccent' : 'inkMuted'}>
                        {t(`lostItem.items.${value}`)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <TextField
              label={t('lostItem.descriptionLabel')}
              placeholder={t('lostItem.descriptionPlaceholder')}
              value={description}
              onChangeText={(value) => {
                setDescription(value);
                if (bodyError) {
                  setBodyError(false);
                }
              }}
              multiline
              maxLength={2000}
              error={bodyError ? t('lostItem.invalidDescription') : undefined}
            />

            {/* Nota de seguridad: el número del pasajero se mantiene oculto; VEO media el contacto. */}
            <Card variant="filled" padding="md">
              <View style={styles.noteRow}>
                <IconShield color={theme.colors.accent} size={18} />
                <Text variant="footnote" color="inkMuted" style={styles.flex}>
                  {t('lostItem.privacyNote')}
                </Text>
              </View>
            </Card>

            <View style={styles.noteRow}>
              <IconLock color={theme.colors.inkSubtle} size={14} />
              <Text variant="caption" color="inkSubtle" style={styles.flex}>
                {t('lostItem.mediationNote')}
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth },
  noteRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  flex: { flex: 1 },
});
