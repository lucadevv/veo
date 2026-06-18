import {
  Banner,
  Button,
  IconButton,
  SafeScreen,
  spacing,
  Text,
  TextField,
  TOUCH_TARGET,
  useTheme,
} from '@veo/ui-kit';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {
  FadeInView,
  PressableScale,
} from '../../../../shared/presentation/components/motion';
import {OtpField} from '../components/OtpField';
import {IconChevronLeft} from '../components/icons';
import {
  type EmailAuthErrorKind,
  isValidEmail,
  isValidPassword,
  useEmailAuthFlow,
} from '../hooks/useEmailAuthFlow';

/** Sub-pasos internos del flujo de correo. */
type EmailStep = 'form' | 'code' | 'forgot' | 'reset';
/** Modo del formulario principal. */
type FormMode = 'login' | 'register';

const CODE_LENGTH = 6;
const RESEND_SECONDS = 30;

export interface EmailAuthScreenProps {
  /** Vuelve al paso de selección de método (pantalla 'start' de AuthScreen). */
  onBack: () => void;
}

/** Enmascara el correo para el subtítulo del código: "ma···@ejemplo.com". */
function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) {
    return email;
  }
  const head = user.slice(0, 2);
  return `${head}···@${domain}`;
}

/** Formatea segundos a m:ss para la cuenta regresiva de reenvío. */
function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Flujo de ingreso por correo + contraseña (ADR-012). Mismo lenguaje visual que los pasos
 * teléfono/OTP: SafeScreen, Button accent, Banner danger, Text variants, FadeInView, IconChevronLeft
 * y REUSO de OtpField para el código. Toggle iniciar sesión / crear cuenta. Tras
 * verify/login la sesión cambia y el RootNavigator conmuta solo (no se navega imperativamente).
 */
export function EmailAuthScreen({
  onBack,
}: EmailAuthScreenProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const flow = useEmailAuthFlow();

  const [step, setStep] = useState<EmailStep>('form');
  const [mode, setMode] = useState<FormMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [errorNonce, setErrorNonce] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const [resetDone, setResetDone] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  const emailValid = isValidEmail(email);
  const passwordValid = isValidPassword(password);

  // "Shake" del código en cada error de verificación.
  useEffect(() => {
    if (flow.verifyError || flow.resetError === 'invalidCode') {
      setErrorNonce(n => n + 1);
    }
  }, [flow.verifyError, flow.resetError]);

  // Cuenta regresiva del reenvío.
  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }
    const timer = setTimeout(() => setCooldown(value => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  /** Mensaje del Banner para un error clasificado por el hook. */
  const errorMessage = useCallback(
    (kind: EmailAuthErrorKind): string | null => {
      switch (kind) {
        case 'invalidCredentials':
          return t('auth.email.errorInvalidCredentials');
        case 'notVerified':
          return t('auth.email.errorNotVerified');
        case 'alreadyExists':
          return t('auth.email.errorAlreadyExists');
        case 'weakPassword':
          return t('auth.email.errorWeakPassword');
        case 'invalidCode':
          return t('auth.email.errorInvalidCode');
        case 'network':
          return t('auth.email.errorNetwork');
        case 'unknown':
          return t('auth.email.errorUnknown');
        default:
          return null;
      }
    },
    [t],
  );

  /** Crea cuenta → si OK, pasa al paso de código. */
  const submitRegister = useCallback(async () => {
    if (!emailValid || !passwordValid) {
      setTouched(true);
      return;
    }
    try {
      await flow.registerEmail(email, password, name);
      setStep('code');
      setCode('');
      setCooldown(RESEND_SECONDS);
    } catch {
      // El error queda reflejado en flow.registerError (Banner).
    }
  }, [flow, email, password, name, emailValid, passwordValid]);

  /** Inicia sesión → si 403 (no verificado), pasa a código y reenvía. */
  const submitLogin = useCallback(async () => {
    if (!emailValid || password.length < 1) {
      setTouched(true);
      return;
    }
    try {
      await flow.loginEmail(email, password);
    } catch {
      // Si el correo no está verificado (403), llevamos a verificar y reenviamos el código
      // por el endpoint dedicado (sin re-registrar con la contraseña).
      if (flow.loginError === 'notVerified') {
        await flow.resendEmail(email).catch(() => undefined);
        setStep('code');
        setCode('');
        setCooldown(RESEND_SECONDS);
      }
    }
  }, [flow, email, password, emailValid]);

  /** Verifica el código → sesión (el RootNavigator conmuta solo). */
  const submitVerify = useCallback(async () => {
    if (code.length !== CODE_LENGTH) {
      setTouched(true);
      return;
    }
    try {
      await flow.verifyEmail(email, code);
    } catch {
      // El error queda reflejado en flow.verifyError (Banner + shake).
    }
  }, [flow, email, code]);

  /** Reenvía el código de verificación vía el endpoint dedicado (anti-enumeración: siempre {sent:true}). */
  const resendCode = useCallback(async () => {
    try {
      await flow.resendEmail(email);
      setCooldown(RESEND_SECONDS);
    } catch {
      // best-effort: el Banner ya refleja cualquier error.
    }
  }, [flow, email]);

  /** Envía el código de restablecimiento (respuesta uniforme anti-enumeración). */
  const submitForgot = useCallback(async () => {
    if (!emailValid) {
      setTouched(true);
      return;
    }
    try {
      await flow.forgotPassword(email);
      setForgotSent(true);
      setStep('reset');
      setCode('');
      setCooldown(RESEND_SECONDS);
    } catch {
      // El error queda reflejado en flow.forgotError (Banner).
    }
  }, [flow, email, emailValid]);

  /** Reenvía el código de restablecimiento. */
  const resendReset = useCallback(async () => {
    try {
      await flow.forgotPassword(email);
      setCooldown(RESEND_SECONDS);
    } catch {
      // best-effort.
    }
  }, [flow, email]);

  /** Aplica la nueva contraseña → vuelve a login. */
  const submitReset = useCallback(async () => {
    if (code.length !== CODE_LENGTH || !isValidPassword(newPassword)) {
      setTouched(true);
      return;
    }
    try {
      await flow.resetPassword(email, code, newPassword);
      setResetDone(true);
      setMode('login');
      setPassword('');
      setNewPassword('');
      setCode('');
      setStep('form');
    } catch {
      // El error queda reflejado en flow.resetError (Banner + shake).
    }
  }, [flow, email, code, newPassword]);

  const switchMode = useCallback((next: FormMode) => {
    setMode(next);
    setTouched(false);
    setResetDone(false);
  }, []);

  const goToForgot = useCallback(() => {
    setStep('forgot');
    setTouched(false);
    setForgotSent(false);
  }, []);

  const backToForm = useCallback(() => {
    setStep('form');
    setTouched(false);
  }, []);

  const backButton = useCallback(
    (onPress: () => void) => (
      <View style={styles.backRow}>
        <IconButton
          icon={<IconChevronLeft color={theme.colors.ink} />}
          accessibilityLabel={t('auth.back')}
          variant="surface"
          onPress={onPress}
        />
      </View>
    ),
    [theme, t],
  );

  const maskedEmail = useMemo(() => maskEmail(email), [email]);

  /* ── Paso: código de verificación (OtpField + teclado nativo del sistema) ── */
  if (step === 'code') {
    const showCodeError =
      (touched && code.length !== CODE_LENGTH) || Boolean(flow.verifyError);
    return (
      <SafeScreen
        scroll
        footer={
          <Button
            label={t('auth.email.verifyCta')}
            variant="accent"
            fullWidth
            size="lg"
            loading={flow.verifying}
            disabled={code.length !== CODE_LENGTH}
            onPress={submitVerify}
          />
        }>
        {backButton(backToForm)}
        <FadeInView style={styles.copy} offsetY={12}>
          <Text variant="display" align="center">
            {t('auth.email.verifyTitle')}
          </Text>
          <Text
            variant="body"
            color="inkMuted"
            align="center"
            style={styles.subtitle}>
            {t('auth.email.verifySubtitle', {email: maskedEmail})}
          </Text>
        </FadeInView>

        {flow.verifyError ? (
          <Banner
            tone="danger"
            title={errorMessage(flow.verifyError) ?? ''}
            style={{marginBottom: theme.spacing.lg}}
          />
        ) : null}

        <OtpField
          value={code}
          onChangeText={value =>
            setCode(value.replace(/\D/g, '').slice(0, CODE_LENGTH))
          }
          length={CODE_LENGTH}
          hasError={showCodeError}
          errorNonce={errorNonce}
          accessibilityLabel={t('auth.otpLabel')}
        />

        <Text
          variant="footnote"
          color="inkSubtle"
          align="center"
          style={styles.expiry}>
          {t('auth.email.codeExpiry')}
        </Text>

        <ResendRow
          cooldown={cooldown}
          busy={flow.registering}
          onResend={resendCode}
          labelIdle={t('auth.email.resend')}
          labelWaiting={t('auth.email.resendIn', {
            time: formatCountdown(cooldown),
          })}
        />
      </SafeScreen>
    );
  }

  /* ── Paso: olvidé mi contraseña (solo correo) ── */
  if (step === 'forgot') {
    return (
      <SafeScreen
        scroll
        footer={
          <Button
            label={t('auth.email.forgotSendCta')}
            variant="accent"
            fullWidth
            size="lg"
            loading={flow.forgetting}
            disabled={!emailValid}
            onPress={submitForgot}
          />
        }>
        {backButton(backToForm)}
        <FadeInView style={styles.copy} offsetY={12}>
          <Text variant="display">{t('auth.email.forgotTitle')}</Text>
          <Text variant="body" color="inkMuted" style={styles.subtitle}>
            {t('auth.email.forgotSubtitle')}
          </Text>
        </FadeInView>

        {flow.forgotError ? (
          <Banner
            tone="danger"
            title={errorMessage(flow.forgotError) ?? ''}
            style={{marginBottom: theme.spacing.lg}}
          />
        ) : null}

        <TextField
          label={t('auth.email.emailLabel')}
          placeholder={t('auth.email.emailPlaceholder')}
          value={email}
          onChangeText={setEmail}
          error={
            touched && !emailValid ? t('auth.email.invalidEmail') : undefined
          }
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          autoFocus
        />
      </SafeScreen>
    );
  }

  /* ── Paso: restablecer contraseña (código + nueva contraseña) ── */
  if (step === 'reset') {
    const showCodeError =
      (touched && code.length !== CODE_LENGTH) ||
      flow.resetError === 'invalidCode';
    return (
      <SafeScreen
        scroll
        footer={
          <Button
            label={t('auth.email.resetCta')}
            variant="accent"
            fullWidth
            size="lg"
            loading={flow.resetting}
            disabled={
              code.length !== CODE_LENGTH || !isValidPassword(newPassword)
            }
            onPress={submitReset}
          />
        }>
        {backButton(goToForgot)}
        <FadeInView style={styles.copy} offsetY={12}>
          <Text variant="display">{t('auth.email.resetTitle')}</Text>
          <Text variant="body" color="inkMuted" style={styles.subtitle}>
            {t('auth.email.resetSubtitle', {email: maskedEmail})}
          </Text>
        </FadeInView>

        {forgotSent ? (
          <Banner
            tone="info"
            title={t('auth.email.forgotSent')}
            style={{marginBottom: theme.spacing.lg}}
          />
        ) : null}

        {flow.resetError ? (
          <Banner
            tone="danger"
            title={errorMessage(flow.resetError) ?? ''}
            style={{marginBottom: theme.spacing.lg}}
          />
        ) : null}

        <Text variant="subhead" color="inkMuted" style={styles.fieldLabel}>
          {t('auth.email.resetCodeLabel')}
        </Text>
        <OtpField
          value={code}
          onChangeText={value =>
            setCode(value.replace(/\D/g, '').slice(0, CODE_LENGTH))
          }
          length={CODE_LENGTH}
          hasError={Boolean(showCodeError)}
          errorNonce={errorNonce}
          accessibilityLabel={t('auth.email.resetCodeLabel')}
        />

        <View style={styles.resetPassword}>
          <TextField
            label={t('auth.email.passwordLabel')}
            placeholder={t('auth.email.newPasswordPlaceholder')}
            value={newPassword}
            onChangeText={setNewPassword}
            helperText={t('auth.email.passwordHint')}
            error={
              touched && !isValidPassword(newPassword)
                ? t('auth.email.invalidPassword')
                : undefined
            }
            secureTextEntry
            autoCapitalize="none"
            autoComplete="password-new"
            textContentType="newPassword"
          />
        </View>

        <ResendRow
          cooldown={cooldown}
          busy={flow.forgetting}
          onResend={resendReset}
          labelIdle={t('auth.email.resend')}
          labelWaiting={t('auth.email.resendIn', {
            time: formatCountdown(cooldown),
          })}
        />
      </SafeScreen>
    );
  }

  /* ── Paso: formulario principal (toggle login / register) ── */
  const isRegister = mode === 'register';
  const formError = isRegister ? flow.registerError : flow.loginError;
  const submitDisabled = isRegister
    ? !emailValid || !passwordValid
    : !emailValid || password.length < 1;
  return (
    <SafeScreen
      scroll
      footer={
        <Button
          label={
            isRegister ? t('auth.email.registerCta') : t('auth.email.loginCta')
          }
          variant="accent"
          fullWidth
          size="lg"
          loading={isRegister ? flow.registering : flow.loggingIn}
          disabled={submitDisabled}
          onPress={isRegister ? submitRegister : submitLogin}
        />
      }>
      {backButton(onBack)}

      <FadeInView style={styles.copy} offsetY={12}>
        <Text variant="display">{t('auth.email.title')}</Text>
        <Text variant="body" color="inkMuted" style={styles.subtitle}>
          {t('auth.email.subtitle')}
        </Text>
      </FadeInView>

      {/* Segmented toggle iniciar sesión / crear cuenta. */}
      <View
        accessibilityRole="tablist"
        accessibilityLabel={t('auth.email.tabsLabel')}
        style={[
          styles.segment,
          {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.md,
            borderColor: theme.colors.border,
          },
        ]}>
        <SegmentTab
          label={t('auth.email.tabLogin')}
          active={!isRegister}
          onPress={() => switchMode('login')}
        />
        <SegmentTab
          label={t('auth.email.tabRegister')}
          active={isRegister}
          onPress={() => switchMode('register')}
        />
      </View>

      {resetDone ? (
        <Banner
          tone="success"
          title={t('auth.email.resetDone')}
          style={{marginBottom: theme.spacing.lg}}
        />
      ) : null}

      {formError ? (
        <Banner
          tone="danger"
          title={errorMessage(formError) ?? ''}
          style={{marginBottom: theme.spacing.lg}}
        />
      ) : null}

      <View style={styles.fields}>
        <TextField
          label={t('auth.email.emailLabel')}
          placeholder={t('auth.email.emailPlaceholder')}
          value={email}
          onChangeText={setEmail}
          error={
            touched && !emailValid ? t('auth.email.invalidEmail') : undefined
          }
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          autoFocus
        />

        <TextField
          label={t('auth.email.passwordLabel')}
          placeholder={t('auth.email.passwordPlaceholder')}
          value={password}
          onChangeText={setPassword}
          helperText={isRegister ? t('auth.email.passwordHint') : undefined}
          error={
            isRegister && touched && !passwordValid
              ? t('auth.email.invalidPassword')
              : undefined
          }
          secureTextEntry
          autoCapitalize="none"
          autoComplete={isRegister ? 'password-new' : 'password'}
          textContentType={isRegister ? 'newPassword' : 'password'}
        />

        {isRegister ? (
          <TextField
            label={t('auth.email.nameLabel')}
            placeholder={t('auth.email.namePlaceholder')}
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
          />
        ) : null}
      </View>

      {!isRegister ? (
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('auth.email.forgotCta')}
          hitSlop={8}
          onPress={goToForgot}
          contentStyle={styles.forgotLink}>
          <Text variant="subhead" color="accent">
            {t('auth.email.forgotCta')}
          </Text>
        </PressableScale>
      ) : null}
    </SafeScreen>
  );
}

interface SegmentTabProps {
  label: string;
  active: boolean;
  onPress: () => void;
}

/** Pestaña del segmented control (login/register). */
function SegmentTab({
  label,
  active,
  onPress,
}: SegmentTabProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <PressableScale
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{selected: active}}
      onPress={onPress}
      style={styles.segmentTabPressable}
      contentStyle={[
        styles.segmentTab,
        {
          backgroundColor: active
            ? theme.colors.surfaceElevated
            : 'transparent',
          borderRadius: theme.radii.sm,
        },
      ]}>
      <Text variant="bodyStrong" color={active ? 'ink' : 'inkMuted'}>
        {label}
      </Text>
    </PressableScale>
  );
}

interface ResendRowProps {
  cooldown: number;
  busy: boolean;
  onResend: () => void;
  labelIdle: string;
  labelWaiting: string;
}

/** Fila de reenvío del código con cuenta regresiva (mismo patrón visual que el OTP). */
function ResendRow({
  cooldown,
  busy,
  onResend,
  labelIdle,
  labelWaiting,
}: ResendRowProps): React.JSX.Element {
  const theme = useTheme();
  const disabled = cooldown > 0 || busy;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={cooldown > 0 ? labelWaiting : labelIdle}
      accessibilityState={{disabled}}
      disabled={disabled}
      onPress={onResend}
      contentStyle={[
        styles.resendRow,
        {
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
          opacity: disabled ? 0.55 : 1,
        },
      ]}>
      <Text variant="bodyStrong" color="inkMuted" tabular>
        {cooldown > 0 ? labelWaiting : labelIdle}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  backRow: {
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    alignItems: 'flex-start',
  },
  copy: {gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing['2xl']},
  subtitle: {},
  fields: {gap: 18},
  fieldLabel: {marginBottom: spacing.sm},
  segment: {
    flexDirection: 'row',
    padding: spacing.xs,
    gap: spacing.xs,
    borderWidth: 1,
    marginBottom: spacing.xl,
  },
  segmentTabPressable: {flex: 1},
  segmentTab: {
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  forgotLink: {
    alignSelf: 'flex-start',
    marginTop: spacing.lg,
    paddingVertical: spacing.sm,
  },
  expiry: {marginTop: 18},
  resetPassword: {marginTop: 18},
  resendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 52,
    borderWidth: 1,
    marginTop: 18,
  },
});
