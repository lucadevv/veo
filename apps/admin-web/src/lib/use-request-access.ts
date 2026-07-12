'use client';

import { useToast } from '@/components/ui/toast';

/**
 * "Solicitar acceso" del estado 403 (PermissionState). NO hay backend de solicitud de acceso — el overlay
 * lo maneja un admin desde Permisos (Gobierno · ADR-025). Guía HONESTA: no simula un envío, le dice al
 * operador qué permiso pedir y quién lo habilita. Devuelve un handler que toma el slug del permiso.
 */
export function useRequestAccess() {
  const { toast } = useToast();
  return (permission: string) =>
    toast({
      title: 'Pedí acceso a un administrador',
      description: `${permission} lo habilita alguien con Permisos (Gobierno).`,
      tone: 'info',
    });
}
