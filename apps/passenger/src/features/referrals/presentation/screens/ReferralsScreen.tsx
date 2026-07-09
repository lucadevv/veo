import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Banner,
  BottomSheet,
  Button,
  Card,
  hexAlpha,
  ListItem,
  SafeScreen,
  StatusPill,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Clipboard, Pressable, Share, StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {
  ErrorState,
  LoadingState,
} from '../../../../shared/presentation/components/ScreenStates';
import {ScreenHeader} from '../../../../shared/presentation/components/ScreenHeader';
import {formatPEN} from '../../../../shared/utils/format';
import {ReferralCodeError} from '../../domain/usecases';
import type {ReferralCodeReason} from '../../domain/usecases';
import {useUserCredit} from '../hooks/useUserCredit';
import {IconCopy, IconGift, IconShare2} from '../components/icons';

/**
 * "Invita y gana" (Ola 2A), conformado al design/veo.pen AqN7Q:
 *
 *  - HERO: círculo tenue de marca con gift + copy de la recompensa. SIN cifra a propósito: el
 *    monto real es config del backend (`REFERRAL_REWARD_CENTS`, env-configurable, default S/ 5)
 *    y NO viaja en `GET /referrals/me` — el "S/ 10" del pen no es sustentable desde el cliente.
 *  - CÓDIGO: card con el código en MONO grande + pill "Copiar" DENTRO de la card; "Compartir mi
 *    código" como CTA primario full-width separado debajo.
 *  - MÉTRICAS: una card partida en 2 (Invitados / Ganado) con divisor central.
 *  - CANJE: fila navegable (gift + chevron) que abre un BottomSheet con el TextField + CTA de
 *    canje existente (mismos errores/hints de dominio).
 *  - La card de crédito disponible (app-only, dato real del backend) se conserva.
 */
export function ReferralsScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
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
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [redeemCode, setRedeemCode] = useState('');

  const ownCode = summaryQuery.data?.code;

  const redeemMutation = useMutation({
    mutationFn: () => redeemReferral.execute(redeemCode, ownCode),
    onSuccess: summary => {
      queryClient.setQueryData(['referrals', 'me'], summary);
      setRedeemCode('');
    },
  });

  if (summaryQuery.isLoading) {
    return (
      <SafeScreen>
        <ScreenHeader title={t('screens.referrals')} />
        <LoadingState />
      </SafeScreen>
    );
  }

  if (summaryQuery.isError || !summaryQuery.data) {
    return (
      <SafeScreen>
        <ScreenHeader title={t('screens.referrals')} />
        <ErrorState onRetry={() => summaryQuery.refetch()} />
      </SafeScreen>
    );
  }

  const summary = summaryQuery.data;

  const shareMessage = t('referrals.shareMessage', {code: summary.code});

  const onCopy = (): void => {
    Clipboard.setString(summary.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const onShare = (): void => {
    void Share.share({message: shareMessage});
  };

  // `mutate` no lanza: la validación de dominio corre dentro de `mutationFn` y, si falla, el
  // `ReferralCodeError` queda en `redeemMutation.error` (lo distinguimos del error de red abajo).
  const onRedeem = (): void => redeemMutation.mutate();

  const closeRedeem = (): void => {
    setRedeemOpen(false);
    // El sheet se reabre limpio: sin banners viejos ni código a medias de un intento anterior.
    redeemMutation.reset();
    setRedeemCode('');
  };

  const mutationError = redeemMutation.error;
  const codeReason: ReferralCodeReason | null =
    mutationError instanceof ReferralCodeError ? mutationError.reason : null;
  const isNetworkError = Boolean(mutationError) && codeReason === null;

  // Tinte tenue de marca (pen `$brand-dim`): no existe token propio, se deriva del brand con alpha
  // (mismo patrón que la pill de KYC del perfil con `success`).
  const brandDim = hexAlpha(
    theme.colors.brand,
    theme.scheme === 'dark' ? 0.18 : 0.12,
  );

  return (
    <SafeScreen
      padded={false}
      scroll
      contentContainerStyle={{
        padding: theme.spacing.xl,
        gap: theme.spacing['2xl'],
      }}>
      {/* Header in-body (patrón ScreenHeader del pen): back pill + título display. */}
      <ScreenHeader title={t('screens.referrals')} />
      {/* HERO per pen: círculo brand-dim con gift + título + subtítulo sustentable (sin cifra). */}
      <View style={[styles.hero, {gap: theme.spacing.lg}]}>
        <View style={[styles.giftCircle, {backgroundColor: brandDim}]}>
          <IconGift color={theme.colors.brand} size={36} />
        </View>
        <View style={[styles.heroTexts, {gap: theme.spacing.sm}]}>
          <Text variant="title2" align="center">
            {t('referrals.heroTitle')}
          </Text>
          <Text variant="callout" color="inkMuted" align="center">
            {t('referrals.heroSubtitle')}
          </Text>
        </View>
      </View>

      {/* Card del código per pen: MONO grande a la izquierda + pill "Copiar" adentro. */}
      <Card variant="outlined" padding="lg">
        <View style={[styles.codeRow, {gap: theme.spacing.md}]}>
          <Text
            variant="title2"
            tabular
            numberOfLines={1}
            accessibilityLabel={summary.code}
            style={[
              styles.code,
              // Cara MONO del tema (el pen pide `$font-mono`); tamaño del rol title2 (el pen usa
              // 22 y la escala no tiene 22 → 24, el token más cercano).
              {fontFamily: theme.typography.fontFamily.mono},
            ]}>
            {summary.code}
          </Text>
          <Pressable
            onPress={onCopy}
            accessibilityRole="button"
            accessibilityLabel={t('referrals.copy')}
            style={[
              styles.copyPill,
              {
                backgroundColor: brandDim,
                borderRadius: theme.radii.pill,
                gap: theme.spacing.xs,
              },
            ]}>
            <IconCopy color={theme.colors.brand} size={16} />
            <Text variant="subhead" color="brand">
              {copied ? t('referrals.copied') : t('referrals.copy')}
            </Text>
          </Pressable>
        </View>
      </Card>

      {/* CTA primario full-width per pen, separado de la card del código. */}
      <Button
        label={t('referrals.shareCta')}
        variant="accent"
        fullWidth
        leftIcon={<IconShare2 color={theme.colors.onAccent} size={18} />}
        onPress={onShare}
      />

      {/* Saldo de crédito GASTABLE: aparece SOLO si hay saldo. El cobro lo aplica solo al próximo viaje
          (degradación honesta: no prometemos nada que el server no haga). */}
      {availableCreditCents > 0 ? (
        <Card variant="filled" padding="lg">
          <View style={{gap: theme.spacing.xs}}>
            <Text variant="footnote" color="inkMuted">
              {t('referrals.availableCredit')}
            </Text>
            <Text
              variant="title1"
              tabular
              accessibilityLabel={t('referrals.availableCredit')}>
              {formatPEN(availableCreditCents)}
            </Text>
            <Text variant="footnote" color="inkMuted">
              {t('referrals.creditAutoApply')}
            </Text>
          </View>
        </Card>
      ) : null}

      {/* Métricas per pen: UNA card partida en 2 (Invitados / Ganado) con divisor central. */}
      <Card variant="outlined" padding="none">
        <View style={styles.metricsRow}>
          <View style={[styles.metricCell, {gap: theme.spacing.xs}]}>
            <Text variant="title1" tabular>
              {summary.referredCount}
            </Text>
            <Text variant="footnote" color="inkSubtle">
              {t('referrals.invited')}
            </Text>
          </View>
          <View
            style={[
              styles.metricDivider,
              {backgroundColor: theme.colors.border},
            ]}
          />
          <View style={[styles.metricCell, {gap: theme.spacing.xs}]}>
            <Text variant="title1" tabular>
              {formatPEN(summary.rewardsEarnedCents)}
            </Text>
            <Text variant="footnote" color="inkSubtle">
              {t('referrals.earned')}
            </Text>
          </View>
        </View>
      </Card>

      {/* Canjear un código per pen: fila navegable que abre el sheet con el canje existente. */}
      <Card variant="outlined" padding="none">
        <ListItem
          title={t('referrals.redeemEntry')}
          leading={<IconGift color={theme.colors.inkMuted} size={20} />}
          chevron
          onPress={() => setRedeemOpen(true)}
          style={{paddingHorizontal: theme.spacing.lg}}
        />
      </Card>

      {/* Sheet de canje: el bloque inline anterior, con los MISMOS errores/hints de dominio. */}
      <BottomSheet
        visible={redeemOpen}
        onClose={closeRedeem}
        title={t('referrals.redeemSection')}
        footer={
          redeemMutation.isSuccess ? (
            <Button
              label={t('actions.close')}
              fullWidth
              onPress={closeRedeem}
            />
          ) : (
            <Button
              label={t('referrals.redeem')}
              fullWidth
              loading={redeemMutation.isPending}
              disabled={redeemCode.trim().length === 0}
              onPress={onRedeem}
            />
          )
        }>
        <View style={{gap: theme.spacing.md}}>
          {redeemMutation.isSuccess ? (
            <Banner tone="success" title={t('referrals.redeemSuccess')} />
          ) : null}
          {isNetworkError ? (
            <Banner tone="danger" title={t('referrals.redeemError')} />
          ) : null}

          {!redeemMutation.isSuccess ? (
            <TextField
              label={t('referrals.redeemLabel')}
              placeholder={t('referrals.redeemPlaceholder')}
              autoCapitalize="characters"
              autoCorrect={false}
              value={redeemCode}
              onChangeText={value => {
                setRedeemCode(value);
                if (redeemMutation.isError || redeemMutation.isSuccess) {
                  redeemMutation.reset();
                }
              }}
              error={
                codeReason ? t(`referrals.codeError.${codeReason}`) : undefined
              }
            />
          ) : null}
          <StatusPill label={t('referrals.redeemHint')} tone="neutral" />
        </View>
      </BottomSheet>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  hero: {alignItems: 'center', paddingVertical: 8},
  giftCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTexts: {alignItems: 'center', alignSelf: 'stretch'},
  codeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  code: {flex: 1, letterSpacing: 2},
  copyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  metricsRow: {flexDirection: 'row', alignItems: 'stretch'},
  metricCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 20,
    paddingHorizontal: 16,
  },
  metricDivider: {width: StyleSheet.hairlineWidth},
});
