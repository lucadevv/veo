'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, KeyRound, LogIn, ShieldCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { confirmTotp, login } from '@/lib/api/auth';
import type { LoginEnrollment } from '@/lib/api/schemas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Field } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import { OtpInput } from '@/components/ui/otp-input';

type Phase = 'credentials' | 'verify' | 'enroll';

const CHALLENGE_SECONDS = 300;

/** Extrae el secreto base32 del enlace otpauth para mostrarlo como alternativa al QR (no es un secreto de sesión). */
function secretFromOtpauth(otpauthUrl: string): string | null {
  try {
    return new URL(otpauthUrl).searchParams.get('secret');
  } catch {
    return null;
  }
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [totp, setTotp] = useState('');
  const [enrollCode, setEnrollCode] = useState('');
  const [enrollment, setEnrollment] = useState<LoginEnrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgotHint, setForgotHint] = useState(false);
  const [pending, setPending] = useState(false);
  // Nonce para reiniciar el contador de expiración al reenviar el desafío.
  const [challengeNonce, setChallengeNonce] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(CHALLENGE_SECONDS);

  const enrollSecret = useMemo(
    () => (enrollment ? secretFromOtpauth(enrollment.otpauthUrl) : null),
    [enrollment],
  );

  // Cuenta regresiva de expiración del desafío 2FA (se reinicia al entrar o al reenviar).
  useEffect(() => {
    if (phase !== 'verify') return;
    setSecondsLeft(CHALLENGE_SECONDS);
    const id = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [phase, challengeNonce]);

  const timer = useMemo(() => {
    const m = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
    const s = String(secondsLeft % 60).padStart(2, '0');
    return `${m}:${s}`;
  }, [secondsLeft]);

  function goNext() {
    router.replace(next);
  }

  async function onCredentials() {
    setError(null);
    setPending(true);
    try {
      const result = await login(email, password);
      if (result.status === 'authenticated') {
        goNext();
        return;
      }
      if (result.enrollment) {
        // Operador aún sin TOTP → enrolamiento (escanear QR / secreto).
        setEnrollment(result.enrollment);
        setEnrollCode('');
        setPhase('enroll');
      } else {
        // Operador ya enrolado → pedir el código de su app (pantalla 2FA).
        setTotp('');
        setPhase('verify');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo iniciar sesión.');
    } finally {
      setPending(false);
    }
  }

  async function onVerify() {
    setError(null);
    setPending(true);
    try {
      const result = await login(email, password, totp);
      if (result.status === 'authenticated') {
        goNext();
        return;
      }
      setError('El código no es válido. Probá de nuevo.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Código incorrecto.');
    } finally {
      setPending(false);
    }
  }

  async function onResend() {
    setError(null);
    setTotp('');
    setChallengeNonce((n) => n + 1);
    try {
      // Refresca el desafío (no hay envío de SMS en TOTP; renueva la ventana y limpia el estado).
      await login(email, password);
    } catch {
      /* el refresco es best-effort; el operador puede seguir tipeando su código */
    }
  }

  async function onConfirmEnroll() {
    setError(null);
    setPending(true);
    try {
      await confirmTotp(email, password, enrollCode);
      goNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Código incorrecto.');
    } finally {
      setPending(false);
    }
  }

  if (phase === 'verify') {
    return (
      <div className="flex flex-col items-center gap-5 text-center">
        <div className="grid size-[60px] place-items-center rounded-[16px] bg-accent/10">
          <ShieldCheck className="size-[30px] text-accent" aria-hidden />
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-2xl font-bold tracking-[-0.4px] text-ink">
            Verificación en dos pasos
          </h1>
          <p className="text-sm leading-relaxed text-ink-muted">
            Ingresá el código de 6 dígitos de tu app autenticadora.
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onVerify();
          }}
          className="flex w-full flex-col gap-5"
          noValidate
        >
          <OtpInput value={totp} onChange={setTotp} length={6} autoFocus />
          {error ? (
            <p role="alert" className="text-xs font-medium text-danger">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            className="h-12 w-full text-[15px] shadow-brand"
            loading={pending}
            disabled={totp.length < 6}
          >
            <ArrowRight className="size-[18px]" aria-hidden />
            Verificar
          </Button>
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => void onResend()}
              className="text-[13px] font-medium text-accent hover:underline"
            >
              Reenviar código
            </button>
            <span className="font-mono text-[13px] text-ink-subtle">Vence en {timer}</span>
          </div>
        </form>
      </div>
    );
  }

  if (phase === 'enroll') {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="flex items-center gap-2 font-display text-2xl font-bold text-ink">
            <KeyRound className="size-5 text-accent" aria-hidden />
            Configurá tu autenticador
          </h1>
          <p className="text-sm leading-relaxed text-ink-muted">
            Aún no tenés verificación en dos pasos. Agregá esta cuenta en tu app (Google
            Authenticator, Aegis) y luego ingresá el primer código para activarla.
          </p>
        </div>

        {enrollment ? (
          <div className="rounded-lg border border-border bg-surface-2 p-4">
            <div className="mb-3 flex justify-center">
              <div className="rounded-md bg-white p-3" aria-label="Código QR para tu app de autenticación">
                <QRCodeSVG value={enrollment.otpauthUrl} size={176} level="M" />
              </div>
            </div>
            <p className="mb-2 text-center text-xs text-ink-muted">
              Escaneá el QR con tu app. ¿No podés escanear? Ingresá el secreto a mano:
            </p>
            {enrollSecret ? (
              <dl className="text-xs">
                <dt className="text-ink-muted">Secreto</dt>
                <dd className="break-all font-mono text-ink">{enrollSecret}</dd>
              </dl>
            ) : null}
          </div>
        ) : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onConfirmEnroll();
          }}
          className="flex flex-col gap-5"
          noValidate
        >
          <Field label="Código de 6 dígitos" error={error ?? undefined}>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="••••••"
              value={enrollCode}
              onChange={(e) => setEnrollCode(e.target.value.replace(/\D/g, ''))}
              className="text-center font-display tracking-[0.4em]"
            />
          </Field>
          <Button type="submit" className="h-12 w-full text-[15px] shadow-brand" loading={pending} disabled={enrollCode.length < 6}>
            Activar y entrar
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => {
              setPhase('credentials');
              setEnrollCode('');
              setError(null);
            }}
          >
            Volver
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-display text-[26px] font-bold tracking-[-0.4px] text-ink">
          Bienvenido de vuelta
        </h1>
        <p className="text-sm text-ink-muted">Ingresá con tu cuenta de administrador</p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onCredentials();
        }}
        className="flex flex-col gap-5"
        noValidate
      >
        <Field label="Correo electrónico">
          <Input
            type="email"
            autoComplete="username"
            inputMode="email"
            placeholder="tu@veo.pe"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field label="Contraseña" error={error ?? undefined}>
          <PasswordInput
            autoComplete="current-password"
            placeholder="••••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <div className="flex items-center justify-between">
          <Checkbox
            label="Recordarme"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <button
            type="button"
            onClick={() => setForgotHint(true)}
            className="text-[13px] font-medium text-accent hover:underline"
          >
            ¿Olvidaste tu contraseña?
          </button>
        </div>
        {forgotHint ? (
          <p className="text-xs text-ink-muted">
            Pedile a un administrador que restablezca tu acceso desde Operadores.
          </p>
        ) : null}

        <Button
          type="submit"
          className="h-12 w-full text-[15px] shadow-brand"
          loading={pending}
          disabled={!email || !password}
        >
          <LogIn className="size-[18px]" aria-hidden />
          Ingresar al panel
        </Button>
      </form>

      <div className="border-t border-border" />

      <p className="flex items-center justify-center gap-1.5 text-xs text-ink-subtle">
        <ShieldCheck className="size-3.5" aria-hidden />
        Protegido con segundo factor (TOTP)
      </p>
    </div>
  );
}
