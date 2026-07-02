import {
  Banner,
  Button,
  IconButton,
  SafeScreen,
  spacing,
  Text,
  useTheme,
} from '@veo/ui-kit';
import React, {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Platform, StyleSheet, TextInput, View} from 'react-native';
import {
  FadeInView,
  PressableScale,
} from '../../../../shared/presentation/components/motion';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {uuidv7} from '../../../../shared/utils/uuid';
import {CONSENT_POLICY_VERSION} from '../../domain/usecases';
import {PendingConsentStatus} from '../../domain/pendingConsent';
import {isValidPhone, useAuthFlow} from '../hooks/useAuthFlow';
import {type OAuthErrorKind, useOAuthFlow} from '../hooks/useOAuthFlow';
import {useOnboardingStore} from '../stores/onboardingStore';
import {OtpField} from '../components/OtpField';
import {BrandBadge, IconApple, IconCheck, IconChevronLeft} from '../components/icons';

/** Color de marca de Google (explícito del diseño, no token de tema). */
const GOOGLE_BLUE = '#4285F4';
const OTP_LENGTH = 6;
const RESEND_SECONDS = 30;
const PHONE_DIGITS = 9;

/** Mapea el error del login social a la key i18n del Banner (cancelado/null → sin Banner). */
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
      return null;
  }
}

/** Formatea segundos a m:ss para la cuenta regresiva de reenvío. */
function formatCountdown(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface ConsentCheckProps {
  checked: boolean;
  label: string;
  onToggle: () => void;
}

/** Checkbox de consentimiento (Ley N.° 29733) — fiel a `design/veo.pen` P/Auth. */
function ConsentCheck({
  checked,
  label,
  onToggle,
}: ConsentCheckProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <PressableScale
      accessibilityRole="checkbox"
      accessibilityState={{checked}}
      accessibilityLabel={label}
      onPress={onToggle}
      contentStyle={styles.consentRow}>
      <View
        style={[
          styles.checkBox,
          {
            backgroundColor: checked ? theme.colors.accent : 'transparent',
            borderColor: checked
              ? theme.colors.accent
              : theme.colors.borderStrong,
          },
        ]}>
        {checked ? <IconCheck color={theme.colors.onAccent} size={14} /> : null}
      </View>
      <Text variant="footnote" color="inkMuted" style={styles.consentLabel}>
        {label}
      </Text>
    </PressableScale>
  );
}

/**
 * Ingreso del pasajero — pantalla ÚNICA phone-first, fiel a `design/veo.pen` P/Auth:
 * flecha atrás, teléfono + OTP (6 casillas SIEMPRE visibles), los 3 consentimientos Ley N.° 29733
 * INLINE (gatean el ingreso), y Google/Apple LADO A LADO ("o continúa con") + Continuar. La lógica
 * real (`useAuthFlow`/`useOAuthFlow`) queda intacta; el consentimiento se captura en la cola durable
 * y `verifyOtp` la sincroniza tras el login. La UI no autoriza: el gate real es server-side.
 */
export function AuthScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const flow = useAuthFlow();
  const oauth = useOAuthFlow();
  const pendingConsentStore = useDependency(TOKENS.pendingConsentStore);
  const resetOnboarding = useOnboardingStore(state => state.reset);

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [touched, setTouched] = useState(false);
  const [errorNonce, setErrorNonce] = useState(0);
  const [phoneFocused, setPhoneFocused] = useState(false);
  const [data, setData] = useState(false);
  const [camera, setCamera] = useState(false);
  const [loc, setLoc] = useState(false);

  const allConsents = data && camera && loc;
  const phoneValid = isValidPhone(phone);

  useEffect(() => {
    if (flow.verifyError) {
      setErrorNonce(n => n + 1);
    }
  }, [flow.verifyError]);

  useEffect(() => {
    if (cooldown <= 0) {
      return;
    }
    const timer = setTimeout(() => setCooldown(v => v - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  /**
   * Encola la aceptación de consentimiento (Ley N.° 29733) en la cola durable con un `dedupKey`
   * único. Se llama al iniciar CUALQUIER método (teléfono/Google/Apple) con los 3 aceptados; el
   * primer flush ocurre tras el login (queda Pending y se entrega post-JWT).
   */
  const captureConsent = useCallback(() => {
    pendingConsentStore.save({
      status: PendingConsentStatus.Pending,
      selection: {
        dataProcessing: true,
        inCabinCamera: true,
        location: true,
        marketing: false,
      },
      policyVersion: CONSENT_POLICY_VERSION,
      dedupKey: uuidv7(),
      capturedAt: new Date().toISOString(),
      attempts: 0,
    });
  }, [pendingConsentStore]);

  const sendCode = useCallback(async () => {
    if (!phoneValid || !allConsents) {
      setTouched(true);
      return;
    }
    captureConsent();
    try {
      await flow.requestOtp(phone);
      setCodeSent(true);
      setCooldown(RESEND_SECONDS);
    } catch {
      // El error queda reflejado en flow.requestError (Banner).
    }
  }, [phoneValid, allConsents, captureConsent, flow, phone]);

  const verify = useCallback(async () => {
    if (code.length !== OTP_LENGTH) {
      setTouched(true);
      return;
    }
    try {
      await flow.verifyOtp(phone, code);
    } catch {
      // El error queda reflejado en flow.verifyError (Banner + shake).
    }
  }, [code, flow, phone]);

  const resend = useCallback(async () => {
    try {
      await flow.requestOtp(phone);
      setCooldown(RESEND_SECONDS);
    } catch {
      // best-effort: el Banner refleja el error.
    }
  }, [flow, phone]);

  const socialSignIn = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (!allConsents) {
        setTouched(true);
        return;
      }
      captureConsent();
      try {
        await fn();
      } catch {
        // El error queda clasificado en oauth.*Error (Banner). Cancelar no pinta nada.
      }
    },
    [allConsents, captureConsent],
  );

  const googleErrorCopy = oauthErrorCopy(oauth.googleError);
  const appleErrorCopy = oauthErrorCopy(oauth.appleError);

  const primaryDisabled = codeSent
    ? code.length !== OTP_LENGTH
    : !phoneValid || !allConsents;

  return (
    <SafeScreen
      scroll
      footer={
        <Button
          label={t('actions.continue')}
          variant="accent"
          fullWidth
          size="lg"
          loading={codeSent ? flow.verifying : flow.requesting}
          disabled={primaryDisabled}
          onPress={codeSent ? verify : sendCode}
        />
      }>
      {/* Atrás → vuelve al onboarding (fiel al .pen). */}
      <View style={styles.backRow}>
        <IconButton
          icon={<IconChevronLeft color={theme.colors.ink} />}
          accessibilityLabel={t('auth.back')}
          variant="surface"
          onPress={resetOnboarding}
        />
      </View>

      <FadeInView style={styles.header} offsetY={12}>
        <Text variant="title1">{t('auth.phoneTitle')}</Text>
        <Text variant="body" color="inkMuted" style={styles.subtitle}>
          {t('auth.phoneSubtitle')}
        </Text>
      </FadeInView>

      {/* Teléfono */}
      <View style={styles.field}>
        <Text variant="footnote" color="inkMuted" style={styles.fieldLabel}>
          {t('auth.phoneLabel')}
        </Text>
        <View
          style={[
            styles.phoneInput,
            {
              backgroundColor: theme.colors.surface,
              borderColor: phoneFocused
                ? theme.colors.focus
                : theme.colors.borderStrong,
              borderRadius: theme.radii.md,
            },
          ]}>
          <Text
            style={[
              styles.prefix,
              {
                color: theme.colors.ink,
                fontFamily: theme.typography.fontFamily.mono,
              },
            ]}>
            {t('auth.countryCode')}
          </Text>
          <View
            style={[styles.divider, {backgroundColor: theme.colors.borderStrong}]}
          />
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
            editable={!codeSent}
            style={[
              styles.numberInput,
              {
                color: theme.colors.ink,
                fontFamily: theme.typography.fontFamily.mono,
              },
            ]}
          />
        </View>
      </View>

      {flow.requestError ? (
        <Banner
          tone="danger"
          title={t('auth.errorRequest')}
          description={t('auth.errorRequestHint')}
          style={styles.banner}
        />
      ) : null}

      {/* OTP — 6 casillas SIEMPRE visibles (fiel al .pen); se habilita tras enviar el código. */}
      <View style={styles.field}>
        <Text variant="footnote" color="inkMuted" style={styles.fieldLabel}>
          {t('auth.otpLabel')}
        </Text>
        <OtpField
          value={code}
          onChangeText={v => setCode(v.replace(/\D/g, '').slice(0, OTP_LENGTH))}
          length={OTP_LENGTH}
          hasError={Boolean(flow.verifyError)}
          errorNonce={errorNonce}
          editable={codeSent}
          accessibilityLabel={t('auth.otpLabel')}
        />
        {codeSent ? (
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
            contentStyle={styles.resendHit}>
            <Text
              variant="footnote"
              color={cooldown > 0 ? 'inkSubtle' : 'accent'}>
              {cooldown > 0
                ? t('auth.resendIn', {time: formatCountdown(cooldown)})
                : t('auth.resend')}
            </Text>
          </PressableScale>
        ) : null}
        {flow.verifyError ? (
          <Banner
            tone="danger"
            title={t('auth.errorVerify')}
            style={styles.otpBanner}
          />
        ) : null}
      </View>

      {/* Consentimientos Ley N.° 29733 (gatean el ingreso) */}
      <View style={styles.consents}>
        <ConsentCheck
          checked={data}
          label={t('auth.consentData')}
          onToggle={() => setData(v => !v)}
        />
        <ConsentCheck
          checked={camera}
          label={t('auth.consentCamera')}
          onToggle={() => setCamera(v => !v)}
        />
        <ConsentCheck
          checked={loc}
          label={t('auth.consentLocation')}
          onToggle={() => setLoc(v => !v)}
        />
      </View>

      {/* Divisor "o continúa con" */}
      <View style={styles.orDivider}>
        <View style={[styles.line, {backgroundColor: theme.colors.border}]} />
        <Text variant="caption" color="inkSubtle">
          {t('auth.orContinueWith')}
        </Text>
        <View style={[styles.line, {backgroundColor: theme.colors.border}]} />
      </View>

      {googleErrorCopy ? (
        <Banner
          tone="danger"
          title={t('auth.oauthErrorTitle')}
          description={t(googleErrorCopy)}
          style={styles.banner}
        />
      ) : null}
      {appleErrorCopy ? (
        <Banner
          tone="danger"
          title={t('auth.oauthErrorTitle')}
          description={t(appleErrorCopy)}
          style={styles.banner}
        />
      ) : null}

      {/* Google / Apple — LADO A LADO (fiel al .pen) */}
      <View style={styles.social}>
        <View style={styles.socialHalf}>
          <Button
            label="Google"
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
            onPress={() => void socialSignIn(oauth.signInWithGoogle)}
          />
        </View>
        {Platform.OS === 'ios' ? (
          <View style={styles.socialHalf}>
            <Button
              label="Apple"
              variant="secondary"
              fullWidth
              size="lg"
              loading={oauth.appleLoading}
              disabled={oauth.googleLoading}
              leftIcon={<IconApple color={theme.colors.ink} size={20} />}
              onPress={() => void socialSignIn(oauth.signInWithApple)}
            />
          </View>
        ) : null}
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  backRow: {marginTop: spacing.xs, marginBottom: spacing.sm},
  header: {gap: spacing.sm, marginBottom: spacing.xl},
  subtitle: {},
  field: {marginBottom: spacing.lg},
  fieldLabel: {marginBottom: spacing.sm},
  phoneInput: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: 16,
    borderWidth: 1,
  },
  prefix: {fontSize: 16},
  divider: {width: 1, height: 24, marginHorizontal: 12},
  numberInput: {flex: 1, fontSize: 16, letterSpacing: 1, paddingVertical: 14},
  banner: {marginBottom: spacing.lg},
  otpBanner: {marginTop: spacing.md, marginBottom: 0},
  resendHit: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
  },
  consents: {gap: spacing.md, marginBottom: spacing.xl},
  consentRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  checkBox: {
    width: 22,
    height: 22,
    borderRadius: 8,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  consentLabel: {flex: 1},
  orDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  line: {flex: 1, height: 1},
  social: {flexDirection: 'row', gap: spacing.md},
  socialHalf: {flex: 1},
});
