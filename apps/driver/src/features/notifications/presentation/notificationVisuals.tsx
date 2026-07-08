import type React from 'react';
import {
  IconBell,
  IconCar,
  IconGift,
  IconReceipt,
  IconShield,
  type IconProps,
} from '../../../shared/presentation/icons';
import type { NotificationKind } from '../domain';

/** Color de tono (clave del theme) del ícono según la categoría del aviso. */
export type NotificationTone = 'accent' | 'warn' | 'success' | 'inkMuted';

/** Glifo propio (line-icon "Midnight Motion") por categoría de aviso. */
export function iconForKind(kind: NotificationKind): (props: IconProps) => React.JSX.Element {
  switch (kind) {
    case 'TRIP':
      return IconCar;
    case 'RECEIPT':
      return IconReceipt;
    case 'SAFETY':
      return IconShield;
    case 'PROMO':
      return IconGift;
    case 'GENERAL':
    default:
      return IconBell;
  }
}

/** Tono del ícono por categoría: seguridad resalta (ámbar), viaje/promo usan el acento, recibo éxito. */
export function toneForKind(kind: NotificationKind): NotificationTone {
  switch (kind) {
    case 'SAFETY':
      return 'warn';
    case 'RECEIPT':
      return 'success';
    case 'TRIP':
    case 'PROMO':
      return 'accent';
    case 'GENERAL':
    default:
      return 'inkMuted';
  }
}
