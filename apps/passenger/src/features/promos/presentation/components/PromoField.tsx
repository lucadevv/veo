import {useMutation} from '@tanstack/react-query';
import {
  Banner,
  Button,
  IconButton,
  StatusPill,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {formatPEN} from '../../../../shared/utils/format';
import {applyDiscount} from '../../domain/entities';
import {PromoInputError} from '../../domain/usecases';

/** Cupón aplicado con éxito: lo que el padre necesita para enviar `promoCode` y mostrar el total. */
export interface AppliedPromo {
  code: string;
  discountCents: number;
}

export interface PromoFieldProps {
  /** Tarifa bruta cotizada (céntimos PEN) sobre la que se valida el cupón. */
  fareCents: number;
  /** Cupón aplicado actualmente (estado elevado al padre para enviarlo en createTrip). */
  applied: AppliedPromo | null;
  onApplied: (promo: AppliedPromo) => void;
  onCleared: () => void;
}

/**
 * Campo discreto "¿Tienes un cupón?" para la pantalla de cotización. Por defecto es solo un enlace;
 * al tocarlo despliega el input. Valida contra `POST /promos/validate` con la tarifa cotizada y, si
 * es válido, muestra el descuento y el nuevo total con un chip de éxito (acento reservado al ahorro).
 *
 * El estado del cupón APLICADO se eleva al padre (RouteQuoteScreen), que envía `promoCode` al crear
 * el viaje. Aquí solo vive el estado efímero del input y el resultado de la última validación.
 */
export function PromoField({
  fareCents,
  applied,
  onApplied,
  onCleared,
}: PromoFieldProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const validatePromo = useDependency(TOKENS.validatePromoUseCase);

  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');

  const validateMutation = useMutation({
    mutationFn: () => validatePromo.execute(code, fareCents),
    onSuccess: result => {
      if (result.valid) {
        onApplied({code: result.code, discountCents: result.discountCents});
        setOpen(false);
        setCode('');
      }
    },
  });

  // Cupón aplicado: tarjeta de éxito compacta con el ahorro y el nuevo total.
  if (applied) {
    const newTotal = applyDiscount(fareCents, applied.discountCents);
    return (
      <View
        style={[
          styles.appliedCard,
          {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.lg,
            padding: theme.spacing.md,
          },
        ]}>
        <View style={styles.appliedHeader}>
          <StatusPill
            label={t('promo.appliedTitle', {code: applied.code})}
            tone="accent"
            dot
          />
          <IconButton
            accessibilityLabel={t('promo.remove')}
            variant="plain"
            size="sm"
            onPress={onCleared}
            icon={
              <Text variant="bodyStrong" color="inkMuted">
                ✕
              </Text>
            }
          />
        </View>
        <View style={[styles.totalRow, {marginTop: theme.spacing.sm}]}>
          <Text variant="footnote" color="inkMuted">
            {t('promo.discount')}
          </Text>
          <Text variant="footnote" color="accent" tabular>
            −{formatPEN(applied.discountCents)}
          </Text>
        </View>
        <View style={styles.totalRow}>
          <Text variant="callout">{t('promo.newTotal')}</Text>
          <Text variant="bodyStrong" tabular>
            {formatPEN(newTotal)}
          </Text>
        </View>
      </View>
    );
  }

  // Colapsado: enlace discreto, no intrusivo.
  if (!open) {
    return (
      <Button
        label={t('promo.cta')}
        variant="ghost"
        size="sm"
        onPress={() => setOpen(true)}
      />
    );
  }

  const result = validateMutation.data;
  const isInvalid =
    validateMutation.isSuccess && result ? !result.valid : false;
  const inputError =
    validateMutation.error instanceof PromoInputError
      ? validateMutation.error.reason
      : null;
  const isNetworkError = Boolean(validateMutation.error) && inputError === null;

  return (
    <View style={{gap: theme.spacing.sm}}>
      {isInvalid ? (
        <Banner tone="warn" title={result?.reason ?? t('promo.invalid')} />
      ) : null}
      {isNetworkError ? (
        <Banner tone="danger" title={t('promo.error')} />
      ) : null}
      <TextField
        label={t('promo.label')}
        placeholder={t('promo.placeholder')}
        autoCapitalize="characters"
        autoCorrect={false}
        value={code}
        onChangeText={value => {
          setCode(value);
          if (validateMutation.isError || validateMutation.isSuccess) {
            validateMutation.reset();
          }
        }}
        error={inputError === 'emptyCode' ? t('promo.emptyCode') : undefined}
        rightIcon={
          <Button
            label={
              validateMutation.isPending
                ? t('promo.applying')
                : t('promo.apply')
            }
            variant="accent"
            size="sm"
            loading={validateMutation.isPending}
            disabled={code.trim().length === 0 || validateMutation.isPending}
            onPress={() => validateMutation.mutate()}
          />
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  appliedCard: {},
  appliedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});
