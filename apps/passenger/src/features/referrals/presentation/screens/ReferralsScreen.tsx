import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banner,
  Button,
  Card,
  IconButton,
  SafeScreen,
  StatusPill,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clipboard, Share, StyleSheet, View } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { ErrorState, LoadingState } from '../../../../shared/presentation/components/ScreenStates';
import { formatPEN } from '../../../../shared/utils/format';
import { ReferralCodeError } from '../../domain/usecases';
import type { ReferralCodeReason } from '../../domain/usecases';
import { useUserCredit } from '../../../payments/presentation/hooks/useUserCredit';

/**
 * "Invita y gana" (Ola 2A). Muestra el código propio del pasajero en grande con copiar/compartir,
 * cuántos referidos lleva y cuánto ha ganado, y un campo para canjear el código de un amigo.
 *
 * Diseño Midnight Motion: acento lima reservado para el código propio (el "héroe" de la pantalla) y
 * el CTA de compartir; el resto en superficie neutra. Feedback inmediato al copiar/canjear.
 */
export function ReferralsScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const getSummary = useDependency(TOKENS.getReferralSummaryUseCase);
  const redeemReferral = useDependency(TOKENS.redeemReferralUseCase);

  const summaryQuery = useQuery({
    queryKey: ['referrals', 'me'],
    queryFn: () => getSummary.execute(),
  });

  // Saldo de crédito GASTABLE (Ola 2A · Lote C). Secundario: no bloquea la pantalla; la card solo aparece
  // si hay saldo > 0. El cobro lo aplica solo (server-side); acá solo se MUESTRA.
  const creditQuery = useUserCredit();
  const availableCreditCents = creditQuery.data?.balanceCents ?? 0;

  const [copied, setCopied] = useState(false);
  const [redeemCode, setRedeemCode] = useState('');

  const ownCode = summaryQuery.data?.code;

  const redeemMutation = useMutation({
    mutationFn: () => redeemReferral.execute(redeemCode, ownCode),
    onSuccess: (summary) => {
      queryClient.setQueryData(['referrals', 'me'], summary);
      setRedeemCode('');
    },
  });

  if (summaryQuery.isLoading) {
    return (
      <SafeScreen>
        <LoadingState />
      </SafeScreen>
    );
  }

  if (summaryQuery.isError || !summaryQuery.data) {
    return (
      <SafeScreen>
        <ErrorState onRetry={() => summaryQuery.refetch()} />
      </SafeScreen>
    );
  }

  const summary = summaryQuery.data;

  const shareMessage = t('referrals.shareMessage', { code: summary.code });

  const onCopy = (): void => {
    Clipboard.setString(summary.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const onShare = (): void => {
    void Share.share({ message: shareMessage });
  };

  // `mutate` no lanza: la validación de dominio corre dentro de `mutationFn` y, si falla, el
  // `ReferralCodeError` queda en `redeemMutation.error` (lo distinguimos del error de red abajo).
  const onRedeem = (): void => redeemMutation.mutate();

  const mutationError = redeemMutation.error;
  const codeReason: ReferralCodeReason | null =
    mutationError instanceof ReferralCodeError ? mutationError.reason : null;
  const isNetworkError = Boolean(mutationError) && codeReason === null;

  return (
    <SafeScreen padded={false} scroll contentContainerStyle={{ padding: theme.spacing.xl, gap: theme.spacing.xl }}>
      <View style={{ gap: theme.spacing.xs }}>
        <Text variant="title2">{t('referrals.title')}</Text>
        <Text variant="callout" color="inkMuted">
          {t('referrals.subtitle')}
        </Text>
      </View>

      {/* Código propio: el héroe de la pantalla, único uso del acento lima. */}
      <Card variant="filled" padding="xl">
        <View style={{ gap: theme.spacing.md, alignItems: 'center' }}>
          <Text variant="footnote" color="inkMuted">
            {t('referrals.yourCode')}
          </Text>
          <Text variant="display" color="accent" align="center" tabular accessibilityLabel={summary.code}>
            {summary.code}
          </Text>
          <View style={[styles.actionsRow, { gap: theme.spacing.sm }]}>
            <Button
              label={copied ? t('referrals.copied') : t('referrals.copy')}
              variant="secondary"
              size="md"
              onPress={onCopy}
            />
            <Button label={t('referrals.share')} variant="accent" size="md" onPress={onShare} />
          </View>
        </View>
      </Card>

      {/* Saldo de crédito GASTABLE: aparece SOLO si hay saldo. El cobro lo aplica solo al próximo viaje
          (degradación honesta: no prometemos nada que el server no haga). Superficie neutra: el acento
          lima queda reservado al código héroe. */}
      {availableCreditCents > 0 ? (
        <Card variant="filled" padding="lg">
          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="footnote" color="inkMuted">
              {t('referrals.availableCredit')}
            </Text>
            <Text variant="title1" tabular accessibilityLabel={t('referrals.availableCredit')}>
              {formatPEN(availableCreditCents)}
            </Text>
            <Text variant="footnote" color="inkMuted">
              {t('referrals.creditAutoApply')}
            </Text>
          </View>
        </Card>
      ) : null}

      {/* Métricas: referidos y crédito ganado. */}
      <View style={[styles.statsRow, { gap: theme.spacing.md }]}>
        <Card variant="outlined" padding="lg" style={styles.statCard}>
          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="title1" tabular>
              {summary.referredCount}
            </Text>
            <Text variant="footnote" color="inkMuted">
              {t('referrals.referredCount')}
            </Text>
          </View>
        </Card>
        <Card variant="outlined" padding="lg" style={styles.statCard}>
          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="title1" tabular>
              {formatPEN(summary.rewardsEarnedCents)}
            </Text>
            <Text variant="footnote" color="inkMuted">
              {t('referrals.rewardsEarned')}
            </Text>
          </View>
        </Card>
      </View>

      {/* Canjear el código de un amigo. */}
      <View style={{ gap: theme.spacing.md }}>
        <Text variant="subhead" color="inkMuted">
          {t('referrals.redeemSection')}
        </Text>

        {redeemMutation.isSuccess ? (
          <Banner tone="success" title={t('referrals.redeemSuccess')} />
        ) : null}
        {isNetworkError ? <Banner tone="danger" title={t('referrals.redeemError')} /> : null}

        <TextField
          label={t('referrals.redeemLabel')}
          placeholder={t('referrals.redeemPlaceholder')}
          autoCapitalize="characters"
          autoCorrect={false}
          value={redeemCode}
          onChangeText={(value) => {
            setRedeemCode(value);
            if (redeemMutation.isError || redeemMutation.isSuccess) {
              redeemMutation.reset();
            }
          }}
          error={codeReason ? t(`referrals.codeError.${codeReason}`) : undefined}
          rightIcon={
            <IconButton
              accessibilityLabel={t('referrals.redeem')}
              variant="tinted"
              size="sm"
              disabled={redeemCode.trim().length === 0 || redeemMutation.isPending}
              onPress={onRedeem}
              icon={
                <Text variant="bodyStrong" color="onAccent">
                  →
                </Text>
              }
            />
          }
        />
        <StatusPill label={t('referrals.redeemHint')} tone="neutral" />
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  actionsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  statsRow: { flexDirection: 'row' },
  statCard: { flex: 1 },
});
