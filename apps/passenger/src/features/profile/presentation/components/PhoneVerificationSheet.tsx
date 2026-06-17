import type {PassengerProfile} from '@veo/api-client';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {
  Banner,
  BottomSheet,
  Button,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {ApiError} from '@veo/api-client';
import {StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {useSessionStore} from '../../../../core/session/sessionStore';
import {profileQueryKey} from '../hooks/useProfileCompletion';
import {
  PHONE_CODE_LENGTH,
  PHONE_LOCAL_LENGTH,
  isPeruMobileValid,
} from '../../domain/phoneVerification';
import {PhoneValidationError} from '../../domain/usecases';
import {OtpField} from '../../../auth/presentation/components/OtpField';
import {EnterView, SuccessCheck} from './motion';

export interface PhoneVerificationSheetProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * SHEET de verificación de CELULAR para usuarios que entraron por correo/Google/Apple (perfil sin
 * `phone`). Dos pasos con momento propio:
 *
 *  1. `form` — un campo de 9 dígitos (prefijo +51 fijo) → POST /users/me/phone/request {phone} →
 *     {sent}. Validación local antes de la red (no dispara POST con un número mal).
 *  2. `code` — reusa el `OtpField` del auth (mismo lenguaje visual del OTP) → POST
 *     /users/me/phone/verify {phone, code} → 200 PassengerProfile (ya con phone) → refresca la caché.
 *  3. `done` — feedback sutil (check) y cierre.
 *
 * DEGRADACIÓN HONESTA: el backend de estos endpoints está en construcción PARALELA. Si el request
 * falla (red / 404 / 5xx del endpoint que aún no existe), NO mostramos un error técnico: un banner
 * honesto ("por ahora no pudimos enviar el código, probá en un ratito") y el sheet sigue usable.
 */
export function PhoneVerificationSheet({
  visible,
  onClose,
}: PhoneVerificationSheetProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const queryClient = useQueryClient();
  const userId = useSessionStore(s => s.user?.id ?? null);

  const requestCode = useDependency(TOKENS.requestPhoneCodeUseCase);
  const verifyPhone = useDependency(TOKENS.verifyPhoneUseCase);

  const [phase, setPhase] = React.useState<'form' | 'code' | 'done'>('form');
  const [phone, setPhone] = React.useState('');
  const [code, setCode] = React.useState('');
  const [phoneTouched, setPhoneTouched] = React.useState(false);
  const [codeErrorNonce, setCodeErrorNonce] = React.useState(0);

  // Reinicia el estado interno cada vez que el sheet se abre (sin arrastrar una sesión anterior).
  React.useEffect(() => {
    if (visible) {
      setPhase('form');
      setPhone('');
      setCode('');
      setPhoneTouched(false);
      setCodeErrorNonce(0);
      requestMutation.reset();
      verifyMutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const phoneValid = isPeruMobileValid(phone);
  const codeValid = code.length === PHONE_CODE_LENGTH;

  const requestMutation = useMutation({
    mutationFn: () => requestCode.execute(phone),
    onSuccess: () => {
      setCode('');
      setCodeErrorNonce(0);
      setPhase('code');
    },
  });

  const verifyMutation = useMutation({
    mutationFn: () => verifyPhone.execute(phone, code),
    onSuccess: (profile: PassengerProfile) => {
      // Refleja el perfil ya con teléfono para que la cabecera/completitud conmuten sin refetch.
      queryClient.setQueryData(profileQueryKey(userId), profile);
      void queryClient.invalidateQueries({queryKey: ['profile']});
      setPhase('done');
      setTimeout(onClose, 1100);
    },
    onError: () => {
      // Código equivocado → "shake" del OtpField (sube el nonce) sin romper el flujo.
      setCodeErrorNonce(n => n + 1);
    },
  });

  // El request degrada honesto si el endpoint aún no responde (cualquier error que NO sea la
  // validación local del número). La validación local se muestra como error de campo, no banner.
  const requestFieldError =
    requestMutation.error instanceof PhoneValidationError
      ? t('profile.phoneInvalid')
      : undefined;
  const requestUnavailable =
    requestMutation.isError &&
    !(requestMutation.error instanceof PhoneValidationError);

  // El verify distingue "código equivocado" (mensaje de campo) de "endpoint caído" (banner honesto).
  const codeWrong =
    verifyMutation.error instanceof ApiError &&
    verifyMutation.error.status < 500;
  const verifyUnavailable =
    verifyMutation.isError &&
    !codeWrong &&
    !(verifyMutation.error instanceof PhoneValidationError);

  let body: React.ReactNode;

  if (phase === 'done') {
    body = (
      <View style={styles.doneWrap}>
        <SuccessCheck />
        <Text variant="title3">{t('profile.phoneAddedTitle')}</Text>
        <Text variant="callout" color="inkMuted" style={styles.center}>
          {t('profile.phoneAddedBody')}
        </Text>
      </View>
    );
  } else if (phase === 'code') {
    body = (
      <View style={{gap: theme.spacing.lg}}>
        <View style={{gap: 4}}>
          <Text variant="callout" color="inkMuted">
            {t('profile.phoneCodeIntro', {
              phone: `${t('profile.phoneFieldPrefix')} ${phone}`,
            })}
          </Text>
        </View>
        <OtpField
          value={code}
          onChangeText={next =>
            setCode(next.replace(/\D/g, '').slice(0, PHONE_CODE_LENGTH))
          }
          length={PHONE_CODE_LENGTH}
          hasError={codeWrong}
          errorNonce={codeErrorNonce}
          accessibilityLabel={t('profile.phoneCodeLabel')}
        />
        {codeWrong ? (
          <Text variant="footnote" color="danger" style={styles.center}>
            {t('profile.phoneCodeInvalid')}
          </Text>
        ) : null}
        {verifyUnavailable ? (
          <Banner tone="warn" title={t('profile.phoneUnavailable')} />
        ) : null}
        <Button
          label={
            verifyMutation.isPending
              ? t('profile.phoneVerifying')
              : t('profile.phoneVerify')
          }
          variant="accent"
          fullWidth
          loading={verifyMutation.isPending}
          disabled={!codeValid}
          onPress={() => verifyMutation.mutate()}
        />
        <View style={styles.codeActions}>
          <Button
            label={t('profile.phoneResend')}
            variant="ghost"
            onPress={() => {
              setCode('');
              requestMutation.mutate();
            }}
          />
          <Button
            label={t('profile.phoneChangeNumber')}
            variant="ghost"
            onPress={() => {
              setCode('');
              setPhase('form');
            }}
          />
        </View>
      </View>
    );
  } else {
    body = (
      <View style={{gap: theme.spacing.lg}}>
        <Text variant="callout" color="inkMuted">
          {t('profile.phoneSheetIntro')}
        </Text>
        <TextField
          label={t('profile.phoneFieldLabel')}
          placeholder={t('profile.phoneFieldPlaceholder')}
          keyboardType="number-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          maxLength={PHONE_LOCAL_LENGTH}
          value={phone}
          onChangeText={next =>
            setPhone(next.replace(/\D/g, '').slice(0, PHONE_LOCAL_LENGTH))
          }
          helperText={t('profile.phoneFieldPrefix')}
          error={
            requestFieldError ??
            (phoneTouched && !phoneValid
              ? t('profile.phoneInvalid')
              : undefined)
          }
        />
        {requestUnavailable ? (
          <Banner tone="warn" title={t('profile.phoneUnavailable')} />
        ) : null}
        <Button
          label={
            requestMutation.isPending
              ? t('profile.phoneSending')
              : t('profile.phoneSendCode')
          }
          variant="accent"
          fullWidth
          loading={requestMutation.isPending}
          onPress={() => {
            if (!phoneValid) {
              setPhoneTouched(true);
              return;
            }
            requestMutation.mutate();
          }}
        />
      </View>
    );
  }

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('profile.phoneSheetTitle')}>
      <EnterView offsetY={6}>{body}</EnterView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  center: {textAlign: 'center'},
  doneWrap: {alignItems: 'center', gap: 12, paddingVertical: 16},
  codeActions: {flexDirection: 'row', justifyContent: 'center', gap: 8},
});
