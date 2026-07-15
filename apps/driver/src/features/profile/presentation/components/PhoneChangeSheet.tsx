import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@veo/api-client';
import { Banner, BottomSheet, Button, SuccessCheck, Text, TextField, useTheme } from '@veo/ui-kit';
import { isValidPeruPhone } from '../../../auth/domain';
import { PhoneChangeValidationError } from '../../domain';
import { useRequestPhoneChange, useVerifyPhoneChange } from '../hooks/useProfile';

/** Longitud local del celular peruano (9 dígitos, empieza con 9). */
const PHONE_LOCAL_LENGTH = 9;
/** Longitud del OTP (la misma del login). */
const CODE_LENGTH = 6;
/** Milisegundos que el paso "listo" queda visible antes de autocerrar el sheet. */
const DONE_AUTOCLOSE_MS = 1400;

export interface PhoneChangeSheetProps {
  visible: boolean;
  onClose: () => void;
}

/**
 * SHEET de CAMBIO de número del conductor (semántica del dueño: el OTP va por SMS al número NUEVO,
 * que al verificar pasa a ser el teléfono de LOGIN). Dos pasos + cierre, patrón del
 * `PhoneVerificationSheet` del pasajero con los componentes canónicos del driver (ui-kit):
 *
 *  1. `form` — número nuevo de 9 dígitos (prefijo +51 como helper) → POST /drivers/me/phone/request.
 *     Validación local antes de la red; 409 = el número es de otra cuenta (PHONE_TAKEN).
 *  2. `code` — OTP de 6 dígitos → POST /drivers/me/phone/verify → invalida el perfil (lo hace el
 *     hook) y avisa que ese número es el nuevo ingreso.
 *  3. `done` — check de éxito + copy "desde ahora ingresas con este número" y autocierre.
 */
export function PhoneChangeSheet({ visible, onClose }: PhoneChangeSheetProps): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  const request = useRequestPhoneChange();
  const verify = useVerifyPhoneChange();

  const [phase, setPhase] = useState<'form' | 'code' | 'done'>('form');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [phoneTouched, setPhoneTouched] = useState(false);

  // Reinicia el estado interno en cada apertura (sin arrastrar una sesión anterior del sheet).
  useEffect(() => {
    if (visible) {
      setPhase('form');
      setPhone('');
      setCode('');
      setPhoneTouched(false);
      request.reset();
      verify.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const phoneValid = isValidPeruPhone(phone);
  const codeValid = code.length === CODE_LENGTH;

  const onSendCode = (): void => {
    if (!phoneValid) {
      setPhoneTouched(true);
      return;
    }
    request.mutate(phone, {
      onSuccess: () => {
        setCode('');
        setPhase('code');
      },
    });
  };

  const onVerify = (): void => {
    verify.mutate(
      { phone, code },
      {
        onSuccess: () => {
          setPhase('done');
          setTimeout(onClose, DONE_AUTOCLOSE_MS);
        },
      },
    );
  };

  // 409 = PHONE_TAKEN (el número pertenece a otra cuenta): mensaje específico, no banner genérico.
  const isTaken = (err: unknown): boolean => err instanceof ApiError && err.status === 409;

  const requestFieldError =
    request.error instanceof PhoneChangeValidationError ? t('profile.phoneChange.invalid') : undefined;
  const requestTaken = isTaken(request.error);
  const requestUnavailable = request.isError && !requestTaken && !requestFieldError;

  // Código equivocado / vencido (4xx que no es taken) vs servicio caído (red / 5xx).
  const codeWrong =
    verify.error instanceof ApiError && verify.error.status < 500 && !isTaken(verify.error);
  const verifyTaken = isTaken(verify.error);
  const verifyUnavailable =
    verify.isError &&
    !codeWrong &&
    !verifyTaken &&
    !(verify.error instanceof PhoneChangeValidationError);

  let body: React.ReactNode;

  if (phase === 'done') {
    body = (
      <View style={styles.doneWrap}>
        <SuccessCheck size={64} />
        <Text variant="title3">{t('profile.phoneChange.doneTitle')}</Text>
        <Text variant="callout" color="inkMuted" align="center">
          {t('profile.phoneChange.doneBody')}
        </Text>
      </View>
    );
  } else if (phase === 'code') {
    body = (
      <View style={{ gap: theme.spacing.lg }}>
        <Text variant="callout" color="inkMuted">
          {t('profile.phoneChange.codeIntro', {
            phone: `${t('profile.phoneChange.fieldPrefix')} ${phone}`,
          })}
        </Text>
        <TextField
          label={t('profile.phoneChange.codeLabel')}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          maxLength={CODE_LENGTH}
          value={code}
          onChangeText={(next: string) => setCode(next.replace(/\D/g, '').slice(0, CODE_LENGTH))}
          error={codeWrong ? t('profile.phoneChange.codeInvalid') : undefined}
        />
        {verifyTaken ? <Banner tone="danger" title={t('profile.phoneChange.taken')} /> : null}
        {verifyUnavailable ? (
          <Banner tone="warn" title={t('profile.phoneChange.unavailable')} />
        ) : null}
        <Button
          label={
            verify.isPending ? t('profile.phoneChange.verifying') : t('profile.phoneChange.verify')
          }
          variant="primary"
          fullWidth
          loading={verify.isPending}
          disabled={!codeValid}
          onPress={onVerify}
        />
        <View style={styles.codeActions}>
          <Button
            label={t('profile.phoneChange.resend')}
            variant="ghost"
            disabled={request.isPending}
            onPress={() => {
              setCode('');
              request.mutate(phone);
            }}
          />
          <Button
            label={t('profile.phoneChange.editNumber')}
            variant="ghost"
            onPress={() => {
              setCode('');
              verify.reset();
              setPhase('form');
            }}
          />
        </View>
      </View>
    );
  } else {
    body = (
      <View style={{ gap: theme.spacing.lg }}>
        <Text variant="callout" color="inkMuted">
          {t('profile.phoneChange.intro')}
        </Text>
        <TextField
          label={t('profile.phoneChange.fieldLabel')}
          placeholder={t('profile.phoneChange.fieldPlaceholder')}
          keyboardType="number-pad"
          textContentType="telephoneNumber"
          autoComplete="tel"
          maxLength={PHONE_LOCAL_LENGTH}
          value={phone}
          onChangeText={(next: string) =>
            setPhone(next.replace(/\D/g, '').slice(0, PHONE_LOCAL_LENGTH))
          }
          // Prefijo del país DENTRO del campo (feedback del dueño: como helper quedaba una
          // línea suelta debajo; mismo patrón inline que el AuthScreen y el sheet del passenger).
          leftIcon={
            <Text variant="body" color="inkMuted">
              {t('profile.phoneChange.fieldPrefix')}
            </Text>
          }
          error={
            requestFieldError ??
            (phoneTouched && !phoneValid ? t('profile.phoneChange.invalid') : undefined)
          }
        />
        {requestTaken ? <Banner tone="danger" title={t('profile.phoneChange.taken')} /> : null}
        {requestUnavailable ? (
          <Banner tone="warn" title={t('profile.phoneChange.unavailable')} />
        ) : null}
        <Button
          label={
            request.isPending ? t('profile.phoneChange.sending') : t('profile.phoneChange.sendCode')
          }
          variant="primary"
          fullWidth
          loading={request.isPending}
          onPress={onSendCode}
        />
      </View>
    );
  }

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('profile.phoneChange.title')}>
      {body}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  doneWrap: { alignItems: 'center', gap: 12, paddingVertical: 16 },
  codeActions: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
});
