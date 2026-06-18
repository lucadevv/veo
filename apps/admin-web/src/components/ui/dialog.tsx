'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-backdrop bg-brand/40 backdrop-brightness-75 data-[state=open]:animate-fade-in" />
      {/* Centrado por FLEXBOX (no por transform): la animación scale-in setea `transform` con fill
          `both`, que pisaba el `-translate-x/y-1/2` y dejaba el modal "muy abajo". Con flex, el
          centrado es independiente del transform → la escala anima sin descentrar. */}
      <div className="fixed inset-0 z-modal flex items-center justify-center p-4">
        <DialogPrimitive.Content
          className={cn(
            'relative max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto',
            'rounded-lg border border-border bg-surface p-6 shadow-3',
            'data-[state=open]:animate-scale-in focus:outline-none',
            className,
          )}
          {...props}
        >
          {children}
          <DialogPrimitive.Close
            className="absolute right-4 top-4 grid size-8 place-items-center rounded-md text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            aria-label="Cerrar"
          >
            <X className="size-4" aria-hidden />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col gap-1.5 pr-8', className)} {...props} />;
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title className={cn('text-lg font-semibold text-ink', className)} {...props} />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn('text-sm text-ink-muted', className)} {...props} />
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}
