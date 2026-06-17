import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTranslation } from 'react-i18next';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  Banner,
  Button,
  Card,
  IconButton,
  SafeScreen,
  Text,
  TextField,
  useTheme,
  useReducedMotion,
} from '@veo/ui-kit';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { IconChevronLeft } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { VeoWordmark } from '../../../../shared/presentation/components/VeoWordmark';
import { isValidPeruPhone } from '../../domain';
import { useLogin, useRequestOtp } from '../hooks/useAuth';
import { useBiometricRelogin } from '../hooks/useBiometricRelogin';

type Step = 'phone' | 'code';

// Longitud del OTP (solo presentación: la lógica/validación de `code` no cambia).
const OTP_LENGTH = 6;

/**
 * Enmascara el teléfono para el subtítulo del paso de código (transformación puramente visual,
 * no altera el valor de estado `phone` que consumen los hooks).
 */
const maskPhone = (value: string): string => {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) {
    return value;
  }
  const last = digits.slice(-3);
  return `+51 ··· ··· ${last}`;
};

/**
 * Motivo decorativo de "línea de ruta" cian para la cabecera (Midnight Motion). Es solo adorno:
 * no captura toques (`pointerEvents="none"`) y usa el acento del tema en baja opacidad.
 */
const RouteMotif = ({ color }: { color: string }): React.JSX.Element => (
  <Svg
    width="100%"
    height={150}
    viewBox="0 0 320 150"
    fill="none"
    style={styles.motif}
    pointerEvents="none"
  >
    <Path
      d="M-10 120 C 70 120, 90 44, 170 44 S 290 120, 340 56"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      opacity={0.1}
    />
    <Path
      d="M-10 104 C 60 104, 80 28, 160 28 S 280 104, 340 40"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeDasharray="1 11"
      opacity={0.5}
    />
  </Svg>
);

/** Glifo de Face ID: escudo con huella (re-login biométrico). */
const FaceIdGlyph = ({ color, size = 30 }: { color: string; size?: number }): React.JSX.Element => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M12 2.5 5 5v6c0 4.4 3 7.5 7 9 4-1.5 7-4.6 7-9V5l-7-2.5Z"
      stroke={color}
      strokeWidth={1.8}
      strokeLinejoin="round"
    />
    <Path d="M9 11a3 3 0 0 1 6 0v3" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    <Path
      d="M12 11v3.5M9 14.5c.5 1 1.6 1.6 3 1.6"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
    />
  </Svg>
);

interface OtpBoxProps {
  char: string;
  isActive: boolean;
  hasError: boolean;
}

/**
 * Casilla individual del OTP. Anima un "pop" sutil (scale) al recibir un dígito y resalta en cian
 * la casilla activa. Solo refleja el estado `code`; no contiene lógica de validación.
 */
const OtpBox = ({ char, isActive, hasError }: OtpBoxProps): React.JSX.Element => {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const pop = useSharedValue(char ? 1 : 0);

  useEffect(() => {
    if (reduced) {
      pop.value = char ? 1 : 0;
      return;
    }
    pop.value = withTiming(char ? 1 : 0, {
      duration: theme.motion.duration.fast,
      easing: Easing.bezier(...theme.motion.easing.standard),
    });
  }, [char, pop, reduced, theme]);

  const popStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pop.value * 0.04 }],
  }));

  const borderColor = hasError
    ? theme.colors.danger
    : isActive
      ? theme.colors.accent
      : char
        ? theme.colors.borderStrong
        : theme.colors.border;

  return (
    <Animated.View
      style={[
        styles.otpBox,
        {
          backgroundColor: theme.colors.surfaceElevated,
          borderColor,
          borderWidth: isActive || hasError ? 2 : 1,
          borderRadius: theme.radii.md,
        },
        popStyle,
      ]}
    >
      <Text variant="title2" color={char ? 'ink' : 'inkSubtle'} tabular>
        {char || '·'}
      </Text>
    </Animated.View>
  );
};

interface OtpFieldProps {
  value: string;
  onChangeText: (next: string) => void;
  hasError: boolean;
  accessibilityLabel: string;
}

/**
 * Render visual de las 6 casillas del OTP. Mantiene la MISMA lógica de estado: un TextInput oculto
 * escribe directamente en `code` vía `onChangeText`. Las cajas reflejan los dígitos con un "pop"
 * sutil; la caja activa se resalta en cian.
 */
const OtpField = ({
  value,
  onChangeText,
  hasError,
  accessibilityLabel,
}: OtpFieldProps): React.JSX.Element => {
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable onPress={() => inputRef.current?.focus()} style={styles.otpRow}>
      {Array.from({ length: OTP_LENGTH }).map((_, index) => {
        const char = value[index] ?? '';
        const isActive =
          focused &&
          (index === value.length || (value.length >= OTP_LENGTH && index === OTP_LENGTH - 1));
        return <OtpBox key={index} char={char} isActive={isActive} hasError={hasError} />;
      })}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        keyboardType="number-pad"
        autoComplete="sms-otp"
        textContentType="oneTimeCode"
        maxLength={OTP_LENGTH}
        autoFocus
        caretHidden
        accessibilityLabel={accessibilityLabel}
        style={styles.otpHiddenInput}
      />
    </Pressable>
  );
};

/**
 * Login del conductor por OTP (teléfono → código). El éxito cambia el estado de sesión y el
 * `RootNavigator` conmuta al flujo protegido; esta pantalla no navega directamente.
 */
export const LoginScreen = (): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const expired = useSessionStore((s) => s.expired);
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  // Permite ocultar la tarjeta de Face ID para ir directo al número ("Usar código en su lugar").
  const [showBiometricCard, setShowBiometricCard] = useState(true);

  const requestOtp = useRequestOtp();
  const login = useLogin();
  const biometric = useBiometricRelogin();
  // En dev ocultamos el re-login biométrico para una pantalla de login LIMPIA (solo teléfono+OTP)
  // durante demos/pruebas. En producción el fast-path Face ID (returning-user) se mantiene intacto.
  const faceIdEnabled = biometric.available && !__DEV__;

  const phoneValid = isValidPeruPhone(phone);
  const codeValid = /^\d{6}$/.test(code);

  const onRequest = () => {
    requestOtp.mutate(phone, { onSuccess: () => setStep('code') });
  };

  const onVerify = () => {
    login.mutate({ phone, code });
  };

  return (
    <SafeScreen scroll>
      {step === 'phone' ? (
        <View style={[styles.section, { gap: theme.spacing['2xl'] }]}>
          {/* Cabecera: motivo de ruta cian decorativo + wordmark único de marca (variante inline). */}
          <View style={styles.headerWrap}>
            <RouteMotif color={theme.colors.accent} />
            <Reveal from="scale" style={styles.brandRow}>
              <VeoWordmark variant="inline" size="sm" />
            </Reveal>
            <Reveal delay={60} style={[styles.titleBlock, { gap: theme.spacing.xs }]}>
              <Text variant="title1">{t('auth.loginTitle')}</Text>
              <Text variant="callout" color="inkMuted">
                {t('auth.loginSubtitle')}
              </Text>
            </Reveal>
          </View>

          {expired ? <Banner tone="warn" title={t('auth.sessionExpired')} /> : null}

          {/* Re-login rápido con biometría del dispositivo (solo si hay token guardado; oculto en dev). */}
          {faceIdEnabled && showBiometricCard ? (
            <Reveal delay={100}>
              <Card variant="filled" padding="xl" style={{ gap: theme.spacing.lg }}>
                <View style={[styles.biometricHead, { gap: theme.spacing.md }]}>
                  <View
                    style={[
                      styles.shieldCircle,
                      { backgroundColor: theme.colors.surface, borderRadius: theme.radii.pill },
                    ]}
                  >
                    <FaceIdGlyph color={theme.colors.accent} />
                  </View>
                  <View style={styles.biometricCopy}>
                    <Text variant="bodyStrong">{t('auth.faceIdTitle')}</Text>
                    <Text variant="footnote" color="inkMuted">
                      {t('auth.faceIdBody')}
                    </Text>
                  </View>
                </View>
                <Button
                  label={t('auth.faceIdTitle')}
                  variant="accent"
                  fullWidth
                  loading={biometric.isPending}
                  onPress={() => {
                    biometric.relogin().catch(() => undefined);
                  }}
                />
                <Button
                  label={t('auth.useCodeInstead')}
                  variant="secondary"
                  size="sm"
                  fullWidth
                  onPress={() => setShowBiometricCard(false)}
                />
                {biometric.error ? (
                  <Banner
                    tone="danger"
                    title={t('errors.generic')}
                    description={toErrorMessage(biometric.error, t)}
                  />
                ) : null}
              </Card>
            </Reveal>
          ) : null}

          {/* Formulario de teléfono con prefijo +51 visible y CTA cian full-width. */}
          <Reveal delay={140} style={[styles.form, { gap: theme.spacing.lg }]}>
            {faceIdEnabled ? (
              <Text variant="footnote" color="inkSubtle" align="center">
                {t('auth.phoneDivider')}
              </Text>
            ) : null}
            <TextField
              label={t('auth.phoneLabel')}
              placeholder={t('auth.phonePlaceholder')}
              helperText={t('auth.loginHelper')}
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              error={phone.length > 0 && !phoneValid ? t('auth.invalidPhone') : undefined}
              leftIcon={
                <View style={[styles.prefix, { borderRightColor: theme.colors.border }]}>
                  <Text variant="bodyStrong" color="inkMuted">
                    +51
                  </Text>
                </View>
              }
            />
            {requestOtp.isError ? (
              <Banner
                tone="danger"
                title={t('errors.generic')}
                description={toErrorMessage(requestOtp.error, t)}
              />
            ) : null}
            <Button
              label={t('auth.requestOtp')}
              variant="accent"
              size="lg"
              fullWidth
              disabled={!phoneValid}
              loading={requestOtp.isPending}
              onPress={onRequest}
            />
          </Reveal>
        </View>
      ) : (
        /* ── Paso CÓDIGO ────────────────────────────────────────────────── */
        <View style={[styles.section, { gap: theme.spacing['2xl'] }]}>
          <IconButton
            icon={<IconChevronLeft color={theme.colors.ink} />}
            accessibilityLabel={t('auth.changeNumber')}
            variant="surface"
            onPress={() => {
              setStep('phone');
              setCode('');
            }}
          />

          <View style={[styles.titleBlock, { gap: theme.spacing.sm }]}>
            <Text variant="title1">{t('auth.codeLabel')}</Text>
            <Text variant="callout" color="inkMuted">
              {t('auth.otpSent', { phone: maskPhone(phone) })}
            </Text>
          </View>

          <View style={[styles.form, { gap: theme.spacing.sm }]}>
            <OtpField
              value={code}
              onChangeText={setCode}
              hasError={code.length > 0 && !codeValid}
              accessibilityLabel={t('auth.codeLabel')}
            />
            {code.length > 0 && !codeValid ? (
              <Text variant="footnote" color="danger" accessibilityRole="alert">
                {t('auth.invalidCode')}
              </Text>
            ) : (
              <Text variant="footnote" color="inkSubtle">
                {t('auth.codeHelper')}
              </Text>
            )}
          </View>

          {login.isError ? (
            <Banner
              tone="danger"
              title={t('errors.generic')}
              description={toErrorMessage(login.error, t)}
            />
          ) : null}

          <View style={[styles.form, { gap: theme.spacing.md }]}>
            <Button
              label={t('auth.verify')}
              variant="accent"
              fullWidth
              disabled={!codeValid}
              loading={login.isPending}
              onPress={onVerify}
            />
            <Button
              label={t('auth.changeNumber')}
              variant="ghost"
              fullWidth
              onPress={() => {
                setStep('phone');
                setCode('');
              }}
            />
          </View>
        </View>
      )}
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  section: { paddingTop: 24 },
  headerWrap: { position: 'relative', paddingTop: 12, gap: 20 },
  motif: { position: 'absolute', top: -8, left: -20, right: -20 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  titleBlock: {},
  form: {},
  biometricHead: { flexDirection: 'row', alignItems: 'center' },
  biometricCopy: { flex: 1, gap: 2 },
  shieldCircle: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  prefix: { paddingRight: 10, borderRightWidth: StyleSheet.hairlineWidth },
  otpRow: { flexDirection: 'row', justifyContent: 'space-between', position: 'relative' },
  otpBox: {
    flex: 1,
    marginHorizontal: 4,
    aspectRatio: 0.82,
    alignItems: 'center',
    justifyContent: 'center',
  },
  otpHiddenInput: { ...StyleSheet.absoluteFill, opacity: 0 },
});
