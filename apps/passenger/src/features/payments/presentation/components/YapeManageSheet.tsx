import type {YapeAffiliationView} from '@veo/api-client';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {
  Banner,
  BottomSheet,
  Button,
  ListItem,
  StatusPill,
  useTheme,
} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {usePaymentPrefsStore} from '../stores/paymentPrefsStore';
import {YAPE_AFFILIATION_QUERY_KEY} from '../hooks/useYapeAffiliation';

export interface YapeManageSheetProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * Sheet chico de GESTIÓN del Yape ya vinculado (tap en su fila · lo más simple del patrón del repo).
 * Dos acciones:
 *  - "Predeterminado ✓ / Usar como predeterminado" — flip del default del perfil a YAPE.
 *  - "Desvincular Yape" — acción destructiva con confirmación inline. Al desvincular, si el default era
 *    YAPE se QUEDA en YAPE (sin afiliación = pago Yape por QR al final, válido); lo avisa el copy.
 */
export function YapeManageSheet({
  visible,
  onClose,
}: YapeManageSheetProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const queryClient = useQueryClient();

  const revokeAffiliation = useDependency(TOKENS.revokeYapeAffiliationUseCase);
  const defaultMethod = usePaymentPrefsStore(s => s.defaultMethod);
  const setDefault = usePaymentPrefsStore(s => s.setDefault);

  const [confirming, setConfirming] = React.useState(false);

  React.useEffect(() => {
    if (visible) {
      setConfirming(false);
      revokeMutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const revokeMutation = useMutation<YapeAffiliationView, Error, void>({
    mutationFn: () => revokeAffiliation.execute(),
    onSuccess: view => {
      queryClient.setQueryData(YAPE_AFFILIATION_QUERY_KEY, view);
      // El default se queda como estaba: si era YAPE, sigue siendo YAPE (QR al final, sin afiliación).
      onClose();
    },
  });

  const isDefault = defaultMethod === 'YAPE';

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('payments.auto.manageTitle')}>
      <View style={{gap: theme.spacing.lg}}>
        {confirming ? (
          <View style={{gap: theme.spacing.md}}>
            <Banner
              tone="warn"
              title={t('payments.auto.unlinkConfirmTitle')}
              description={t('payments.auto.unlinkConfirmBody')}
            />
            {revokeMutation.isError ? (
              <Banner tone="danger" title={t('payments.auto.error')} />
            ) : null}
            <Button
              label={
                revokeMutation.isPending
                  ? t('payments.auto.unlinking')
                  : t('payments.auto.unlinkConfirm')
              }
              variant="danger"
              fullWidth
              loading={revokeMutation.isPending}
              onPress={() => revokeMutation.mutate()}
            />
            <Button
              label={t('payments.auto.cancel')}
              variant="ghost"
              fullWidth
              disabled={revokeMutation.isPending}
              onPress={() => setConfirming(false)}
            />
          </View>
        ) : (
          <View style={{gap: theme.spacing.sm}}>
            <ListItem
              title={t('payments.auto.makeDefault')}
              trailing={
                isDefault ? (
                  <StatusPill
                    label={t('payments.auto.isDefault')}
                    tone="accent"
                    dot
                  />
                ) : undefined
              }
              onPress={isDefault ? undefined : () => setDefault('YAPE')}
              disabled={isDefault}
              accessibilityLabel={t('payments.auto.makeDefault')}
            />
            <ListItem
              title={t('payments.auto.unlink')}
              onPress={() => setConfirming(true)}
              accessibilityLabel={t('payments.auto.unlink')}
            />
          </View>
        )}
      </View>
    </BottomSheet>
  );
}
