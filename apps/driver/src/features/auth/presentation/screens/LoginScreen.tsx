import React, { useEffect, useRef, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
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
  Text,
  TextField,
  useTheme,
  useReducedMotion,
} from '@veo/ui-kit';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import {
  IconAlertCircle,
  IconCheckCircle,
  IconChevronLeft,
  IconSend,
} from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { isValidPeruPhone } from '../../domain';
import { useLogin, useRequestOtp } from '../hooks/useAuth';
import { useBiometricRelogin } from '../hooks/useBiometricRelogin';

type Step = 'phone' | 'code';

// Longitud del OTP (solo presentación: la lógica/validación de `code` no cambia).
const OTP_LENGTH = 6;

// Cooldown (segundos) entre reenvíos de OTP para no spamear el gateway de SMS.
const RESEND_COOLDOWN = 30;

/**
 * Foto POV nocturna del héroe (luces de ciudad + celu con GPS + volante), bundleada por Metro vía
 * `require`. Va a sangre en la banda superior del paso teléfono. La ruta sube 5 niveles desde
 * `…/auth/presentation/screens/` hasta la raíz de `apps/driver/` y baja a `assets/images/auth/`.
 */
const LOGIN_HERO = require('../../../../../assets/images/auth/login-hero.jpg');
/** Alto de la banda hero como FRACCIÓN de la pantalla — el frame C/Login del pen usa 320 de 844 = 0.379. */
const LOGIN_HERO_HEIGHT_RATIO = 320 / 844;

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

/** Formatea segundos restantes a m:ss para el contador de reenvío ("24" → "0:24", "90" → "1:30"). */
const formatMmSs = (totalSeconds: number): string => {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

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
          backgroundColor: hasError ? theme.colors.dangerDim : theme.colors.surfaceElevated,
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
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const expired = useSessionStore((s) => s.expired);
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  // Segundos restantes del cooldown de reenvío de OTP; 0 = habilitado. Arranca al pedir el código.
  const [resendIn, setResendIn] = useState(0);
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
  // Error de FORMATO local (código incompleto mientras se tipea) vs error de VERIFICACIÓN del servidor.
  const otpFormatError = code.length > 0 && !codeValid;
  const otpVerifyError = login.isError;

  // Tick del cooldown de reenvío: baja 1s hasta 0 (setTimeout encadenado, se limpia al desmontar).
  useEffect(() => {
    if (resendIn <= 0) {
      return undefined;
    }
    const id = setTimeout(() => setResendIn(resendIn - 1), 1000);
    return () => clearTimeout(id);
  }, [resendIn]);

  const onRequest = () => {
    requestOtp.mutate(phone, {
      onSuccess: () => {
        setStep('code');
        setResendIn(RESEND_COOLDOWN);
      },
    });
  };

  // Reenvío del OTP (frame C/LoginOtp: "¿No llegó? Reenviar código"): reusa el mismo mutation y
  // reinicia el cooldown. Deshabilitado mientras corre el contador o hay un envío en curso.
  const onResend = () => {
    if (resendIn > 0 || requestOtp.isPending) {
      return;
    }
    setCode('');
    requestOtp.mutate(phone, { onSuccess: () => setResendIn(RESEND_COOLDOWN) });
  };

  const onVerify = () => {
    login.mutate({ phone, code });
  };

  // Gutter lateral del contenido (mismo que hoy). Centraliza el padding horizontal del paso teléfono.
  const sideGutter = theme.spacing['2xl'];
  // Alto de la banda hero = misma FRACCIÓN de pantalla que el frame C/Login del pen (320/844 = 38%).
  // Con `cover` centrado en esta banda, la foto vertical muestra su MEDIO (tablero/celular), como el pen.
  const heroH = Math.round(height * LOGIN_HERO_HEIGHT_RATIO);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.bg }]}>
      {/* Paso teléfono: foto oscura en la banda superior → íconos claros. Paso código: lienzo claro
          sin foto → íconos oscuros del tema (si no, quedarían blancos invisibles tras la migración). */}
      <StatusBar barStyle={step === 'phone' ? 'light-content' : theme.statusBarStyle} />

      {step === 'phone' ? (
        /* ── Paso TELÉFONO (dirección Tesla "banda foto arriba") ─────────── */
        <>
          {/* Foto hero como FONDO ABSOLUTO de la pantalla (FUERA del scroll): banda superior con marco
              FIJO y alto explícito → `cover` calza la foto en un frame real. Dentro del ScrollView el
              alto no se constriñe (los hijos absolutos no lo dimensionan) y la foto salía con zoom/mal
              recorte. La foto va detrás; el contenido scrollea por encima. */}
          <View style={[styles.heroBg, { height: heroH }]} pointerEvents="none">
            {/* Alto EXPLÍCITO en la Image (no absoluteFill): así `cover` centra contra los `heroH` reales
                de la banda y muestra el MEDIO de la foto (tablero). Con absoluteFill la Image se estiraba
                a más alto y cover mostraba el TOP (techo), y la banda lo recortaba. */}
            <Image
              source={LOGIN_HERO}
              style={{ width: '100%', height: heroH }}
              resizeMode="cover"
            />
            {/* Scrim: transparente casi toda la banda (foto entera), fundiendo SOLO el borde inferior al `bg`. */}
            <Svg style={StyleSheet.absoluteFill}>
              <Defs>
                {/* Stops EXACTOS del scrim del pen (eraaq): funde el borde inferior al `bg`. */}
                <LinearGradient id="loginHeroScrim" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={theme.colors.bg} stopOpacity={0} />
                  <Stop offset="0.35" stopColor={theme.colors.bg} stopOpacity={0.12} />
                  <Stop offset="0.72" stopColor={theme.colors.bg} stopOpacity={0.72} />
                  <Stop offset="1" stopColor={theme.colors.bg} stopOpacity={1} />
                </LinearGradient>
              </Defs>
              <Rect x={0} y={0} width="100%" height="100%" fill="url(#loginHeroScrim)" />
            </Svg>
          </View>

          <ScrollView
            style={styles.scrollFill}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            automaticallyAdjustKeyboardInsets
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: insets.bottom + theme.spacing['2xl'] }}
          >
            {/* Spacer transparente: deja ver la banda hero (fija, detrás) y arranca el contenido bajo ella. */}
            <View style={{ height: heroH - theme.spacing['2xl'] }} pointerEvents="none" />

            {/* Contenido sobre `bg` sólido (tapa la foto al scrollear), alineado a la izquierda con el gutter. */}
            <View
              style={[
                styles.body,
                {
                  backgroundColor: theme.colors.bg,
                  paddingHorizontal: sideGutter,
                  gap: theme.spacing['2xl'],
                },
              ]}
            >
              {/* Título directo bajo la banda hero: la foto ya lleva la marca, así que NO repetimos el
                wordmark "VEO CONDUCTORES" (el `loginTitle` ya dice "Ingresa a VEO Conductores") — espeja
                el frame C/Login del pen, que quitó ese lockup redundante. */}
              <Reveal style={{ gap: theme.spacing.xs }}>
                <Text variant="title1">{t('auth.loginTitle')}</Text>
                <Text variant="callout" color="inkMuted">
                  {t('auth.loginSubtitle')}
                </Text>
              </Reveal>

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
              <Reveal delay={140} style={{ gap: theme.spacing.lg }}>
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
                  leftIcon={<IconSend size={20} color={theme.colors.onAccent} />}
                  disabled={!phoneValid}
                  loading={requestOtp.isPending}
                  onPress={onRequest}
                />
              </Reveal>
            </View>
          </ScrollView>
        </>
      ) : (
        /* ── Paso CÓDIGO (limpio, SIN banda; respeta la status bar con padding top manual) ── */
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: sideGutter,
            paddingTop: insets.top + theme.spacing.lg,
            paddingBottom: insets.bottom + theme.spacing['2xl'],
            gap: theme.spacing['2xl'],
          }}
        >
          {/* Back = SOLO el chevron ‹ de iOS, sin círculo/container (regla del dueño, mismo back en
              TODA la app — espeja al TopBar). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('auth.changeNumber')}
            hitSlop={12}
            style={styles.backChevron}
            onPress={() => {
              setStep('phone');
              setCode('');
            }}
          >
            <IconChevronLeft color={theme.colors.ink} size={28} strokeWidth={2.25} />
          </Pressable>

          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="title1">{t('auth.codeLabel')}</Text>
            <Text variant="callout" color="inkMuted">
              {t('auth.otpSent', { phone: maskPhone(phone) })}
            </Text>
          </View>

          <View style={{ gap: theme.spacing.sm }}>
            <OtpField
              value={code}
              onChangeText={(next) => {
                // Al reeditar el código, limpia el error de verificación previo (evita cajas rojas stale).
                if (login.isError) {
                  login.reset();
                }
                setCode(next);
              }}
              hasError={otpFormatError || otpVerifyError}
              accessibilityLabel={t('auth.codeLabel')}
            />
            {otpFormatError ? (
              /* Error de FORMATO local (código incompleto): fila inline con circle-alert + mensaje. */
              <View style={styles.otpErrorRow} accessibilityRole="alert">
                <IconAlertCircle size={16} color={theme.colors.danger} />
                <Text variant="footnote" color="danger">
                  {t('auth.invalidCode')}
                </Text>
              </View>
            ) : otpVerifyError ? (
              /* Error de VERIFICACIÓN del servidor (frame C/LoginOtp-Error): circle-alert + mensaje real
                 del BFF (para el código errado es "Código incorrecto"; para lockout/red, su mensaje). El
                 BFF NO expone "intentos restantes", así que NO se fabrica ese conteo. */
              <View style={styles.otpErrorRow} accessibilityRole="alert">
                <IconAlertCircle size={16} color={theme.colors.danger} />
                <Text variant="footnote" color="danger">
                  {toErrorMessage(login.error, t)}
                </Text>
              </View>
            ) : (
              <Text variant="footnote" color="inkSubtle">
                {t('auth.codeHelper')}
              </Text>
            )}
          </View>

          {/* Reenvío de OTP con cooldown (frame C/LoginOtp): "¿No llegó? Reenviar código". */}
          <View style={styles.resendRow}>
            <Text variant="footnote" color="inkSubtle">
              {t('auth.otpResendPrompt')}
            </Text>
            <Pressable
              onPress={onResend}
              disabled={resendIn > 0 || requestOtp.isPending}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ disabled: resendIn > 0 || requestOtp.isPending }}
            >
              <Text variant="footnote" color={resendIn > 0 ? 'inkSubtle' : 'accent'}>
                {resendIn > 0
                  ? t('auth.otpResendIn', { time: formatMmSs(resendIn) })
                  : t('auth.otpResend')}
              </Text>
            </Pressable>
          </View>

          {/* UNA sola acción por intención (U2 · dedup): verificar el código. Para CAMBIAR el número, la
              única affordance es el chevron back de arriba (gesto idiomático del paso OTP); se quitó el
              Button ghost "Cambiar número" que ejecutaba el MISMO handler que el chevron. El error de
              verificación se muestra inline bajo las cajas (no en Banner). */}
          <View style={{ gap: theme.spacing.md }}>
            <Button
              label={t('auth.verify')}
              variant="accent"
              fullWidth
              leftIcon={<IconCheckCircle size={20} color={theme.colors.onAccent} />}
              disabled={!codeValid}
              loading={login.isPending}
              onPress={onVerify}
            />
          </View>
        </ScrollView>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1 },
  // El chevron de volver no se estira al ancho de la columna (touch target acotado al glifo + hitSlop).
  backChevron: { alignSelf: 'flex-start' },
  // Banda hero como FONDO ABSOLUTO fijo (top de la pantalla): marco definido → `cover` calza la foto
  // sin el zoom/recorte raro que daba estar dentro del ScrollView. El alto va inline (aspecto de la foto).
  heroBg: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden' },
  // ScrollView transparente por encima del fondo hero (deja ver la banda en el tope vía el spacer).
  scrollFill: { flex: 1, backgroundColor: 'transparent' },
  // Contenido: el spacer del tope ya lo baja bajo la banda; sin paddingTop propio.
  body: {},
  biometricHead: { flexDirection: 'row', alignItems: 'center' },
  biometricCopy: { flex: 1, gap: 2 },
  shieldCircle: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  prefix: { paddingRight: 10, borderRightWidth: StyleSheet.hairlineWidth },
  resendRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  otpErrorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
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
