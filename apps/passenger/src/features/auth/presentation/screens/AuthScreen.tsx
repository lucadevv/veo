import {
  Banner,
  Button,
  IconButton,
  SafeScreen,
  spacing,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
  Platform,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  FadeInView,
  PressableScale,
} from '../../../../shared/presentation/components/motion';
import {RouteMotif} from '../../../../shared/presentation/components/RouteMotif';
import {VeoWordmark} from '../../../../shared/presentation/components/VeoWordmark';
import {isValidPhone, useAuthFlow} from '../hooks/useAuthFlow';
import {type OAuthErrorKind, useOAuthFlow} from '../hooks/useOAuthFlow';
import {OtpField} from '../components/OtpField';
import {OtpKeypad} from '../components/OtpKeypad';
import {OtpHelpSheet} from '../components/OtpHelpSheet';
import {EmailAuthScreen} from './EmailAuthScreen';
import {
  BrandBadge,
  IconApple,
  IconChevronLeft,
  IconClock,
  IconMail,
  IconPencil,
  IconPhone,
  IconShieldCheck,
} from '../components/icons';

type Step = 'start' | 'phone' | 'otp' | 'email';

/** Colores de marca de terceros (explícitos del diseño, no tokens de tema). */
const GOOGLE_BLUE = '#4285F4';

/**
 * Métodos de ingreso sin backend todavía; al tocarlos se muestra el aviso honesto.
 * NOTA: `email` ya NO está acá — el correo es REAL (ADR-012), navega al flujo `EmailAuthScreen`.
 * NOTA: `google`/`apple` ya NO están acá — el login social es REAL (OAuth nativo).
 * `call`/`whatsapp` siguen vigentes: los usa el `OtpHelpSheet` (vías alternativas al SMS).
 */
type ComingSoonMethod = 'call' | 'whatsapp';

const COMING_SOON_COPY: Record<ComingSoonMethod, string> = {
  call: 'auth.comingSoonCall',
  whatsapp: 'auth.comingSoonWhatsapp',
};

/**
 * Mapea el error clasificado del login social a la key i18n del Banner danger.
 * `cancelled` (usuario abortó) y `null` no pintan Banner → devuelve `null`.
 */
function oauthErrorCopy(kind: OAuthErrorKind): string | null {
  switch (kind) {
    case 'unavailable':
      return 'auth.oauthErrorUnavailable';
    case 'invalidAccount':
      return 'auth.oauthErrorInvalidAccount';
    case 'network':
      return 'auth.oauthErrorNetwork';
    case 'unknown':
      return 'auth.oauthErrorUnknown';
    default:
      // cancelled | null → sin Banner.
      return null;
  }
}

const OTP_LENGTH = 6;
const RESEND_SECONDS = 30;
const PHONE_DIGITS = 9;

/** Enmascara el teléfono para el subtítulo del OTP: "+51 ··· 321". */
function maskPhone(digits: string): string {
  if (digits.length < 3) {
    return digits;
  }
  return `+51 ··· ${digits.slice(-3)}`;
}

/** Formatea segundos a m:ss para la cuenta regresiva de reenvío. */
function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Pantalla de ingreso en dos pasos: teléfono → OTP. Tras verificar, el store de sesión cambia a
 * `authenticated` y el `RootNavigator` conmuta de stack (no se navega imperativamente). Cabecera
 * con motivo de ruta lima; OTP en 6 casillas con foco animado, shake en error y prefijo +51.
 */
export function AuthScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const flow = useAuthFlow();
  const oauth = useOAuthFlow();
  const {width} = useWindowDimensions();

  const [step, setStep] = useState<Step>('start');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);
  const [phoneFocused, setPhoneFocused] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [errorNonce, setErrorNonce] = useState(0);
  const [helpVisible, setHelpVisible] = useState(false);
  // Aviso honesto "Próximamente" para métodos sin backend. `null` = sin aviso.
  const [comingSoon, setComingSoon] = useState<ComingSoonMethod | null>(null);

  // "Shake" del OTP en cada nuevo error de verificación.
  useEffect(() => {
    if (flow.verifyError) {
      setErrorNonce(n => n + 1);
    }
  }, [flow.verifyError]);

  // Cuenta regresiva para habilitar el reenvío del OTP.
  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }
    const timer = setTimeout(() => setCooldown(value => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const phoneValid = isValidPhone(phone);

  const sendOtp = useCallback(async () => {
    if (!isValidPhone(phone)) {
      setTouched(true);
      return;
    }
    try {
      await flow.requestOtp(phone);
      // Solo avanzamos al paso OTP si la solicitud se resolvió sin error.
      setStep('otp');
      setCooldown(RESEND_SECONDS);
    } catch {
      // El error ya queda reflejado en `flow.requestError` (Banner). Atrapamos aquí para evitar
      // una promesa rechazada sin manejar ante un fallo de red.
    }
  }, [flow, phone]);

  const verify = useCallback(async () => {
    if (code.length !== OTP_LENGTH) {
      setTouched(true);
      return;
    }
    try {
      await flow.verifyOtp(phone, code);
    } catch {
      // El error ya queda reflejado en `flow.verifyError` (Banner + shake). Atrapamos aquí para
      // evitar una promesa rechazada sin manejar ante un fallo de red.
    }
  }, [flow, phone, code]);

  const resend = useCallback(async () => {
    try {
      await flow.requestOtp(phone);
      setCooldown(RESEND_SECONDS);
    } catch {
      // El error ya queda reflejado en `flow.requestError` (Banner). Atrapamos aquí para evitar
      // una promesa rechazada sin manejar ante un fallo de red.
    }
  }, [flow, phone]);

  const changeNumber = useCallback(() => {
    setStep('phone');
    setCode('');
    setTouched(false);
    setHelpVisible(false);
  }, []);

  // Degradación honesta: los métodos sin backend muestran un aviso "Próximamente" (Banner inline,
  // tone="info"). NUNCA simulamos un login ni navegamos al perfil.
  const notifyComingSoon = useCallback((method: ComingSoonMethod) => {
    setHelpVisible(false);
    setComingSoon(method);
  }, []);

  const goToPhone = useCallback(() => {
    setComingSoon(null);
    setStep('phone');
  }, []);

  // El correo es REAL (ADR-012): navega al flujo dedicado de correo + contraseña.
  const goToEmail = useCallback(() => {
    setComingSoon(null);
    setHelpVisible(false);
    setStep('email');
  }, []);

  const backToStart = useCallback(() => {
    setStep('start');
    setTouched(false);
  }, []);

  // Login con Google REAL (OAuth nativo). La UI solo dispara el flujo; el gate es server-side.
  // Cancelación y errores quedan reflejados en `oauth.googleError` (Banner). Atrapamos para evitar
  // una promesa rechazada sin manejar ante un fallo del SDK/red.
  const continueWithGoogle = useCallback(async () => {
    setComingSoon(null);
    try {
      await oauth.signInWithGoogle();
    } catch {
      // El error ya queda clasificado en `oauth.googleError` (Banner). La cancelación no pinta nada.
    }
  }, [oauth]);

  // Sign in with Apple REAL (OAuth nativo, solo iOS por Guideline 4.8).
  const continueWithApple = useCallback(async () => {
    setComingSoon(null);
    try {
      await oauth.signInWithApple();
    } catch {
      // El error ya queda clasificado en `oauth.appleError` (Banner). La cancelación no pinta nada.
    }
  }, [oauth]);

  // El teclado propio del OTP escribe el MISMO `code` que el OtpField (que conserva el autofill SMS):
  // ambos convergen en este setter, recortando a la longitud del OTP.
  const appendDigit = useCallback((digit: string) => {
    setComingSoon(null);
    setCode(prev => (prev + digit).slice(0, OTP_LENGTH));
  }, []);

  const motifWidth = useMemo(() => Math.min(width * 0.5, 220), [width]);

  // Keys i18n del Banner danger del login social (null = cancelado/sin error → no se pinta Banner).
  const googleErrorCopy = oauthErrorCopy(oauth.googleError);
  const appleErrorCopy = oauthErrorCopy(oauth.appleError);

  if (step === 'start') {
    return (
      <SafeScreen scroll>
        {/* Sello de marca: escudo de seguridad con glow (accent) — refuerza "movilidad segura"
            y reemplaza el ícono de ojo anterior (que no comunicaba el valor de la marca). */}
        <View
          style={[
            styles.startBadge,
            {
              backgroundColor: theme.colors.accent,
              borderRadius: theme.radii.lg,
              shadowColor: theme.colors.accent,
            },
          ]}>
          <IconShieldCheck
            color={theme.colors.onAccent}
            onColor={theme.colors.accent}
            size={28}
          />
        </View>

        <FadeInView style={styles.headerCopy} offsetY={12}>
          <Text variant="displayEditorial">{t('auth.startTitle')}</Text>
          <Text variant="body" color="inkMuted" style={styles.subtitle}>
            {t('auth.startSubtitle')}
          </Text>
        </FadeInView>

        {/* Degradación honesta: aviso "Próximamente" para métodos sin backend. */}
        {comingSoon ? (
          <Banner
            tone="info"
            title={t('auth.comingSoonTitle')}
            description={t(COMING_SOON_COPY[comingSoon])}
            style={{marginBottom: theme.spacing.lg}}
          />
        ) : null}

        {/* Error del login social (Google/Apple). Cancelar NO pinta Banner (cancelled → null). */}
        {googleErrorCopy ? (
          <Banner
            tone="danger"
            title={t('auth.oauthErrorTitle')}
            description={t(googleErrorCopy)}
            style={{marginBottom: theme.spacing.lg}}
          />
        ) : null}
        {appleErrorCopy ? (
          <Banner
            tone="danger"
            title={t('auth.oauthErrorTitle')}
            description={t(appleErrorCopy)}
            style={{marginBottom: theme.spacing.lg}}
          />
        ) : null}

        <View style={[styles.startActions, {gap: theme.spacing.md}]}>
          <Button
            label={t('auth.continueGoogle')}
            variant="secondary"
            fullWidth
            size="lg"
            loading={oauth.googleLoading}
            disabled={oauth.appleLoading}
            leftIcon={
              <BrandBadge
                letter="G"
                background={GOOGLE_BLUE}
                foreground="#FFFFFF"
                size={20}
              />
            }
            onPress={continueWithGoogle}
          />
          {/* Sign in with Apple: SOLO iOS (Apple Sign-In no aplica en Android). Botón del ui-kit
              (coherente con Google/correo/teléfono); Apple HIG permite un botón custom con el LOGO
              de Apple + texto aprobado. Prominencia equivalente a Google (Guideline 4.8). */}
          {Platform.OS === 'ios' ? (
            <Button
              label={t('auth.continueApple')}
              variant="secondary"
              fullWidth
              size="lg"
              loading={oauth.appleLoading}
              disabled={oauth.googleLoading}
              leftIcon={<IconApple color={theme.colors.ink} size={20} />}
              onPress={continueWithApple}
            />
          ) : null}
          <Button
            label={t('auth.continueEmail')}
            variant="secondary"
            fullWidth
            size="lg"
            leftIcon={<IconMail color={theme.colors.ink} size={20} />}
            onPress={goToEmail}
          />
          <Button
            label={t('auth.continuePhone')}
            variant="secondary"
            fullWidth
            size="lg"
            leftIcon={<IconPhone color={theme.colors.ink} size={20} />}
            onPress={goToPhone}
          />
        </View>

        <Text variant="footnote" color="inkSubtle" style={styles.startHint}>
          {t('auth.startHint')}
        </Text>
      </SafeScreen>
    );
  }

  if (step === 'email') {
    return <EmailAuthScreen onBack={backToStart} />;
  }

  if (step === 'phone') {
    const showError = touched && !phoneValid;
    return (
      <SafeScreen
        scroll
        footer={
          <Button
            label={t('auth.requestOtp')}
            variant="accent"
            fullWidth
            size="lg"
            loading={flow.requesting}
            disabled={!phoneValid}
            onPress={sendOtp}
          />
        }>
        {/* Botón volver al paso de selección de método (diseño). */}
        <View style={styles.phoneBack}>
          <IconButton
            icon={<IconChevronLeft color={theme.colors.ink} />}
            accessibilityLabel={t('auth.back')}
            variant="surface"
            onPress={backToStart}
          />
        </View>

        {/* Cabecera: badge de marca + motivo de ruta lima. */}
        <View style={styles.phoneHeader}>
          <View
            style={[
              styles.brandBadge,
              {
                backgroundColor: theme.colors.accent,
                borderRadius: theme.radii.lg,
              },
            ]}>
            <VeoWordmark size="sm" color="onAccent" />
          </View>
          <RouteMotif
            width={motifWidth}
            height={70}
            animated
            style={styles.phoneMotif}
          />
        </View>

        <FadeInView style={styles.headerCopy} offsetY={12}>
          <Text variant="displayEditorial">{t('auth.phoneTitle')}</Text>
          <Text variant="body" color="inkMuted" style={styles.subtitle}>
            {t('auth.phoneSubtitle')}
          </Text>
        </FadeInView>

        {flow.requestError ? (
          <Banner
            tone="danger"
            title={t('auth.errorRequest')}
            description={t('auth.errorRequestHint')}
            style={{marginBottom: theme.spacing.lg}}
          />
        ) : null}

        {/* Campo de teléfono con prefijo +51 (sin label visible, como el mockup). */}
        <View
          style={[
            styles.phoneField,
            {
              backgroundColor: theme.colors.surfaceElevated,
              borderColor: showError
                ? theme.colors.danger
                : phoneFocused
                  ? theme.colors.focus
                  : theme.colors.border,
              borderWidth: phoneFocused || showError ? 2 : 1,
              borderRadius: theme.radii.md,
            },
          ]}>
          <View
            style={[styles.prefix, {borderRightColor: theme.colors.border}]}>
            <Text variant="title3" color="inkMuted">
              {t('auth.countryCode')}
            </Text>
          </View>
          <TextInput
            accessibilityLabel={t('auth.phoneLabel')}
            value={phone}
            onChangeText={v =>
              setPhone(v.replace(/\D/g, '').slice(0, PHONE_DIGITS))
            }
            onFocus={() => setPhoneFocused(true)}
            onBlur={() => setPhoneFocused(false)}
            placeholder={t('auth.phonePlaceholder')}
            placeholderTextColor={theme.colors.inkSubtle}
            keyboardType="phone-pad"
            autoComplete="tel"
            textContentType="telephoneNumber"
            autoFocus
            style={[
              styles.phoneInput,
              {
                color: theme.colors.ink,
                fontFamily: theme.typography.fontFamily.text,
              },
            ]}
          />
        </View>
        <Text
          variant="footnote"
          color={showError ? 'danger' : 'inkSubtle'}
          accessibilityRole={showError ? 'alert' : undefined}
          style={styles.helper}>
          {showError ? t('auth.invalidPhone') : t('auth.phoneHelper')}
        </Text>
      </SafeScreen>
    );
  }

  const showOtpError =
    (touched && code.length !== OTP_LENGTH) || flow.verifyError;
  return (
    <SafeScreen
      scroll
      footer={
        <Button
          label={t('auth.verify')}
          variant="accent"
          fullWidth
          size="lg"
          loading={flow.verifying}
          onPress={verify}
        />
      }>
      {/* Cabecera del OTP: volver + wordmark + tagline. */}
      <View style={styles.otpHeader}>
        <IconButton
          icon={<IconChevronLeft color={theme.colors.ink} />}
          accessibilityLabel={t('auth.changeNumber')}
          variant="surface"
          onPress={changeNumber}
          style={styles.backButton}
        />
        <View style={styles.otpBrand}>
          <VeoWordmark
            size="md"
            variant="tagline"
            color="brand"
            tagline={t('brandTaglineCity')}
          />
        </View>
        <View style={styles.backButton} />
      </View>

      <FadeInView style={styles.otpCopy} offsetY={12}>
        <Text variant="displayEditorial" align="center">
          {t('auth.otpTitle')}
        </Text>
        <Text
          variant="body"
          color="inkMuted"
          align="center"
          style={styles.subtitle}>
          {t('auth.otpSubtitle', {phone: maskPhone(phone)})}
        </Text>
      </FadeInView>

      {flow.verifyError ? (
        <Banner
          tone="danger"
          title={t('auth.errorVerify')}
          style={{marginBottom: theme.spacing.lg}}
        />
      ) : null}

      <OtpField
        value={code}
        onChangeText={value =>
          setCode(value.replace(/\D/g, '').slice(0, OTP_LENGTH))
        }
        length={OTP_LENGTH}
        hasError={Boolean(showOtpError)}
        errorNonce={errorNonce}
        accessibilityLabel={t('auth.otpLabel')}
      />

      {/* Teclado numérico propio (diseño). Coexiste con el autofill SMS del OtpField: ambos
          escriben el mismo `code` (el OtpField vía teclado del SO/autofill, este vía appendDigit). */}
      <View style={styles.keypad}>
        <OtpKeypad onPress={appendDigit} />
      </View>

      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t('auth.otpHelpTrigger')}
        onPress={() => setHelpVisible(true)}
        contentStyle={styles.helpTrigger}>
        <Text variant="footnote" color="inkMuted" align="center">
          {t('auth.otpHelpTrigger')}
        </Text>
      </PressableScale>

      <Text
        variant="footnote"
        color="inkSubtle"
        align="center"
        style={styles.expiry}>
        {t('auth.otpExpiry')}
      </Text>

      <View style={[styles.otpActions, {gap: theme.spacing.sm}]}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={
            cooldown > 0
              ? t('auth.resendIn', {time: formatCountdown(cooldown)})
              : t('auth.resend')
          }
          accessibilityState={{disabled: cooldown > 0 || flow.requesting}}
          disabled={cooldown > 0 || flow.requesting}
          onPress={resend}
          contentStyle={[
            styles.otpActionRow,
            {
              borderColor: theme.colors.border,
              borderRadius: theme.radii.md,
              opacity: cooldown > 0 || flow.requesting ? 0.55 : 1,
            },
          ]}>
          <IconClock color={theme.colors.inkMuted} size={18} />
          <Text variant="bodyStrong" color="inkMuted" tabular>
            {cooldown > 0
              ? t('auth.resendIn', {time: formatCountdown(cooldown)})
              : t('auth.resend')}
          </Text>
        </PressableScale>

        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('auth.changeNumber')}
          onPress={changeNumber}
          contentStyle={[
            styles.otpActionRow,
            {borderColor: theme.colors.border, borderRadius: theme.radii.md},
          ]}>
          <IconPencil color={theme.colors.inkMuted} size={18} />
          <Text variant="bodyStrong" color="inkMuted">
            {t('auth.changeNumber')}
          </Text>
        </PressableScale>
      </View>

      <OtpHelpSheet
        visible={helpVisible}
        onClose={() => setHelpVisible(false)}
        onComingSoon={method => {
          // "Mejor entro con correo" ahora es REAL: navega al flujo de correo.
          if (method === 'email') {
            goToEmail();
            return;
          }
          notifyComingSoon(method);
        }}
        onResend={() => {
          setHelpVisible(false);
          void resend();
        }}
        cooldown={cooldown}
        cooldownLabel={formatCountdown(cooldown)}
        resending={flow.requesting}
      />
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  startBadge: {
    width: 54,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing['2xl'],
    marginBottom: spacing['2xl'],
    // Glow lima (route-glow del diseño).
    shadowOpacity: 0.6,
    shadowRadius: 16,
    shadowOffset: {width: 0, height: 0},
    elevation: 8,
  },
  startActions: {marginTop: spacing['2xl']},
  startHint: {marginTop: spacing.lg, lineHeight: 17},
  phoneBack: {
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    alignItems: 'flex-start',
  },
  keypad: {marginTop: 18},
  helpTrigger: {
    alignSelf: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginTop: 14,
  },
  phoneHeader: {
    height: 96,
    justifyContent: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing['2xl'],
  },
  brandBadge: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phoneMotif: {position: 'absolute', right: -8, top: 4},
  headerCopy: {gap: spacing.sm, marginBottom: 28},
  subtitle: {},
  phoneField: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    paddingHorizontal: 18,
  },
  prefix: {
    paddingRight: 14,
    marginRight: 14,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  phoneInput: {
    flex: 1,
    fontSize: 22,
    fontWeight: '600',
    letterSpacing: 1,
    paddingVertical: 14,
  },
  helper: {marginTop: 10},
  otpHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  backButton: {width: 48},
  otpBrand: {alignItems: 'center', gap: spacing.xxs},
  otpCopy: {gap: spacing.sm, marginTop: spacing['2xl'], marginBottom: 28},
  expiry: {marginTop: 18},
  otpActions: {marginTop: 18},
  otpActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    minHeight: 52,
    borderWidth: 1,
  },
});
