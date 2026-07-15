'use client';

import { createContext, forwardRef, useContext, useId } from 'react';
import { cn } from '@/lib/cn';

interface RadioGroupContextValue {
  name: string;
  value: string | undefined;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Valor seleccionado (controlled). */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Nombre del grupo; se propaga a cada Radio. Si se omite, se genera uno estable. */
  name?: string;
  disabled?: boolean;
  /** Etiqueta accesible del grupo (role="radiogroup"). */
  'aria-label'?: string;
}

/**
 * Grupo de radios accesible (role="radiogroup"). Provee `name`/`value`/`onValueChange` por contexto a los
 * `Radio` hijos, que quedan controlados sin repetir props. Los `Radio` también sirven sueltos (fuera del grupo)
 * pasando `checked`/`onChange`/`name` propios.
 */
export function RadioGroup({
  value,
  onValueChange,
  name,
  disabled,
  className,
  children,
  ...props
}: RadioGroupProps) {
  const autoName = useId();
  return (
    <RadioGroupContext.Provider
      value={{ name: name ?? autoName, value, onValueChange, disabled }}
    >
      <div role="radiogroup" className={cn('flex flex-col gap-2', className)} {...props}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

export interface RadioProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Etiqueta a la derecha del control. Sin ella, el componente renderiza SOLO el control (para anidar
   *  dentro de un <label>/card externo, p.ej. una opción con ícono + descripción). */
  label?: string;
}

/**
 * Radio accesible fiel al T/Radio de veo.pen (18px, checked = anillo `brand` con centro blanco). El input
 * nativo (type="radio") queda oculto pero operable (peer): recibe foco, teclado y selección de forma real; el
 * anillo brand aparece al marcarse. Dentro de un RadioGroup toma name/checked/onChange del contexto; suelto,
 * usa sus propias props.
 */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { className, label, id, name, value, checked, onChange, disabled, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const group = useContext(RadioGroupContext);

  const resolvedName = name ?? group?.name;
  const resolvedChecked =
    checked ?? (group && value != null ? group.value === value : undefined);
  const resolvedDisabled = disabled ?? group?.disabled;
  const handleChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    onChange?.(e);
    if (group?.onValueChange && value != null) group.onValueChange(String(value));
  };

  const control = (
    <span className="relative grid size-[18px] place-items-center">
      <input
        ref={ref}
        id={inputId}
        type="radio"
        name={resolvedName}
        value={value}
        checked={resolvedChecked}
        onChange={handleChange}
        disabled={resolvedDisabled}
        className={cn(
          'peer size-[18px] cursor-pointer appearance-none rounded-full border border-border bg-surface transition-colors',
          'checked:border-[6px] checked:border-brand',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    </span>
  );

  if (!label) return control;

  return (
    <label
      htmlFor={inputId}
      className={cn(
        'inline-flex items-center gap-2.5',
        resolvedDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      )}
    >
      {control}
      <span className="text-[13px] text-ink-muted">{label}</span>
    </label>
  );
});
