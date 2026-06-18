'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { confirmTotp, login } from '@/lib/api/auth';
import type { LoginEnrollment } from '@/lib/api/schemas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/ui/field';

type Phase = 'credentials' | 'enroll';

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
  const [totp, setTotp] = useState('');
  const [enrollCode, setEnrollCode] = useState('');
  const [enrollment, setEnrollment] = useState<LoginEnrollment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const enrollSecret = useMemo(
    () => (enrollment ? secretFromOtpauth(enrollment.otpauthUrl) : null),
    [enrollment],
  );

  function goNext() {
    router.replace(next);
  }

  async function onCredentials() {
    setError(null);
    setPending(true);
    try {
      const result = await login(email, password, totp || undefined);
      if (result.status === 'authenticated') {
        goNext();
        return;
      }
      // Operador sin TOTP: pasamos a la pantalla de enrolamiento (escanear QR / ingresar secreto).
      setEnrollment(result.enrollment ?? null);
      setEnrollCode('');
      setPhase('enroll');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo iniciar sesión.');
    } finally {
      setPending(false);
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

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 flex items-center gap-2.5">
        <div className="grid size-9 place-items-center rounded-md bg-accent text-accent-on">
          <ShieldCheck className="size-5" aria-hidden />
        </div>
        <div>
          <p className="font-mono text-lg font-semibold tracking-tight text-ink">VEO</p>
          <p className="text-xs text-ink-muted">Operación y Seguridad</p>
        </div>
      </div>

      {phase === 'credentials' ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onCredentials();
          }}
          className="space-y-5"
          noValidate
        >
          <div>
            <h1 className="text-2xl font-semibold text-ink">Inicia sesión</h1>
            <p className="mt-1 text-sm text-ink-muted">
              Acceso restringido al personal autorizado de VEO.
            </p>
          </div>

          <Field label="Correo corporativo">
            <Input
              type="email"
              autoComplete="username"
              inputMode="email"
              placeholder="nombre@veo.pe"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>

          <Field label="Contraseña">
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <Field
            label="Código de autenticación (si ya lo configuraste)"
            error={error ?? undefined}
            hint="Operadores con TOTP activo: ingresa el código de 6 dígitos de tu app."
          >
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="••••••"
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
              className="text-center font-mono text-lg tracking-[0.4em]"
            />
          </Field>

          <Button type="submit" className="w-full" loading={pending} disabled={!email || !password}>
            Continuar
          </Button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onConfirmEnroll();
          }}
          className="space-y-5"
          noValidate
        >
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-ink">
              <KeyRound className="size-5 text-accent" aria-hidden />
              Configura tu autenticador
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Aún no tienes verificación en dos pasos. Agrega esta cuenta en tu app (Google
              Authenticator, Aegis) y luego ingresa el primer código para activarla.
            </p>
          </div>

          {enrollment ? (
            <div className="rounded-md border border-border bg-surface-2 p-4">
              <div className="mb-3 flex justify-center">
                <div
                  className="rounded-md bg-white p-3"
                  aria-label="Código QR para tu app de autenticación"
                >
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

          <Field label="Código de 6 dígitos" error={error ?? undefined}>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              placeholder="••••••"
              value={enrollCode}
              onChange={(e) => setEnrollCode(e.target.value.replace(/\D/g, ''))}
              className="text-center font-mono text-lg tracking-[0.4em]"
            />
          </Field>

          <Button
            type="submit"
            className="w-full"
            loading={pending}
            disabled={enrollCode.length < 6}
          >
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
      )}
    </div>
  );
}
