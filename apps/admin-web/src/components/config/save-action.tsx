'use client';

import { cn } from '@/lib/cn';
import { Button, type ButtonProps } from '@/components/ui/button';
import { StepUpDialog } from '@/components/security/step-up-dialog';

interface SaveActionProps {
  /** Permiso de gestión (RBAC). Sin él, no se renderiza nada (la nota la pone <ReadOnlyNote>). */
  canManage: boolean;
  /** ¿Hay cambios sin guardar? Sin cambios → Guardar deshabilitado. */
  dirty: boolean;
  /** ¿Algún valor inválido? Inválido → Guardar deshabilitado. */
  invalid: boolean;
  /** ¿Mutación en vuelo? Guardando → Guardar deshabilitado. */
  saving: boolean;
  /** Acción a ejecutar tras el step-up (la mutación CAS del panel). */
  onSave: () => Promise<void> | void;
  /** Título del diálogo de step-up. */
  title: string;
  /** Descripción del diálogo de step-up. */
  description: string;
  /** Tamaño del botón (los paneles estándar usan 'md'; el catálogo usa 'sm'). */
  size?: ButtonProps['size'];
}

/**
 * Botón "Guardar" estándar de los paneles de config (pricing/catálogo): habilitado SOLO con cambios
 * válidos y sin guardado en vuelo, y SIEMPRE detrás de un step-up MFA (acción sensible + auditada).
 * Mata el patrón repetido `canManage ? (disabled : StepUpDialog) : null` de los 6 paneles + el catálogo.
 *
 * La nota de "solo lectura" va aparte (<ReadOnlyNote>) porque vive en otra posición del DOM (a veces en
 * otro componente, ej. costo/km), y juntarlas rompería el layout. Mismo motivo por el que NO se asume el
 * margen acá.
 */
export function SaveAction({
  canManage,
  dirty,
  invalid,
  saving,
  onSave,
  title,
  description,
  size = 'md',
}: SaveActionProps) {
  if (!canManage) return null;

  if (!dirty || invalid || saving) {
    return (
      <Button variant="primary" size={size} disabled>
        Guardar
      </Button>
    );
  }

  return (
    <StepUpDialog
      title={title}
      description={description}
      trigger={
        <Button variant="primary" size={size}>
          Guardar
        </Button>
      }
      onVerified={onSave}
    />
  );
}

interface ReadOnlyNoteProps {
  /** Permiso de gestión (RBAC). Con permiso, no se renderiza nada. */
  canManage: boolean;
  /** Sustantivo de lo que se cambia (ej. "la tarifa base", "el catálogo"). */
  noun: string;
  /** Margen/posición — la deja el panel para preservar el layout exacto (mt-2 vs mt-3 varían por panel). */
  className?: string;
}

/**
 * Nota de "solo lectura" cuando falta el permiso. Va separada de <SaveAction> para conservar la posición
 * EXACTA en el DOM de cada panel (la nota suele ir al final de la sección, no junto al botón).
 */
export function ReadOnlyNote({ canManage, noun, className }: ReadOnlyNoteProps) {
  if (canManage) return null;
  return (
    <p className={cn('text-xs text-ink-subtle', className)}>
      Solo lectura: necesitas el rol FINANCE o ADMIN para cambiar {noun}.
    </p>
  );
}
