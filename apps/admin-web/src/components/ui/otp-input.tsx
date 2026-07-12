'use client';

import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

/**
 * Input de código OTP segmentado (N casillas, una por dígito) — fiel al A/OtpInput de veo.pen. Controlado:
 * `value` es el string de dígitos, `onChange` recibe el string saneado (solo dígitos, cap a `length`).
 * Comportamiento de teclado real: auto-avance al tipear, backspace retrocede, flechas navegan, pegar rellena.
 * La casilla llena/activa se resalta en accent; la vacía usa el borde neutro. Es el mismo dato que el input
 * único que reemplaza (un string de 6 dígitos), solo cambia la presentación.
 */
interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  autoFocus?: boolean;
}

export function OtpInput({ value, onChange, length = 6, autoFocus }: OtpInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');

  const setAt = (i: number, d: string) => {
    const next = digits.slice();
    next[i] = d;
    onChange(next.join('').replace(/\D/g, '').slice(0, length));
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (digits[i]) setAt(i, '');
      else if (i > 0) {
        refs.current[i - 1]?.focus();
        setAt(i - 1, '');
      }
    } else if (e.key === 'ArrowLeft' && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowRight' && i < length - 1) {
      refs.current[i + 1]?.focus();
    }
  };

  const onInput = (i: number, raw: string) => {
    const d = raw.replace(/\D/g, '');
    if (!d) return;
    setAt(i, d.slice(-1));
    if (i < length - 1) refs.current[i + 1]?.focus();
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!pasted) return;
    onChange(pasted);
    refs.current[Math.min(pasted.length, length - 1)]?.focus();
  };

  return (
    <div className="flex gap-2.5" onPaste={onPaste}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={1}
          autoFocus={autoFocus && i === 0}
          aria-label={`Dígito ${i + 1} de ${length}`}
          value={d}
          onChange={(e) => onInput(i, e.target.value)}
          onKeyDown={(e) => onKeyDown(i, e)}
          className={cn(
            'h-[58px] w-full rounded-md bg-surface text-center font-display text-[22px] font-bold text-ink outline-none transition-colors',
            d
              ? 'border-2 border-accent'
              : 'border border-border focus:border-accent',
          )}
        />
      ))}
    </div>
  );
}
