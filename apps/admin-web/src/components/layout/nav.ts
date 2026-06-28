import type { LucideIcon } from 'lucide-react';
import {
  Banknote,
  Car,
  Cctv,
  Coins,
  MapPinned,
  Radar,
  ScrollText,
  ShieldAlert,
  Tags,
  TrendingUp,
  Truck,
  UserCog,
  Users,
  Video,
} from 'lucide-react';
import type { Permission } from '@/lib/rbac';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  permission: Permission;
  /** Coincidencia exacta (no por prefijo) para evitar marcar padres. */
  exact?: boolean;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    title: 'Operación',
    items: [
      { href: '/ops', label: 'En vivo', icon: MapPinned, permission: 'ops:view', exact: true },
      { href: '/ops/metrics', label: 'Métricas', icon: TrendingUp, permission: 'ops:view' },
      { href: '/ops/trips', label: 'Viajes', icon: Car, permission: 'trips:view' },
      { href: '/ops/drivers', label: 'Conductores', icon: Users, permission: 'drivers:view' },
      { href: '/ops/operators', label: 'Operadores', icon: UserCog, permission: 'operators:view' },
      {
        href: '/ops/dispatch-radius',
        label: 'Radios de dispatch',
        icon: Radar,
        permission: 'dispatch:view',
      },
    ],
  },
  {
    title: 'Seguridad',
    items: [
      { href: '/security/panics', label: 'Pánicos', icon: ShieldAlert, permission: 'panics:view' },
      {
        href: '/security/live-wall',
        label: 'Cámaras en vivo',
        icon: Cctv,
        permission: 'live:view',
      },
      { href: '/media', label: 'Video', icon: Video, permission: 'media:view' },
    ],
  },
  {
    title: 'Flota',
    items: [{ href: '/fleet', label: 'Vehículos y docs', icon: Truck, permission: 'fleet:view' }],
  },
  {
    title: 'Finanzas',
    items: [
      {
        href: '/finance',
        label: 'Liquidaciones',
        icon: Banknote,
        permission: 'finance:view',
        exact: true,
      },
      {
        href: '/finance/pricing',
        label: 'Precios y tarifas',
        icon: Coins,
        permission: 'pricing:view',
      },
      {
        href: '/finance/catalog',
        label: 'Catálogo de ofertas',
        icon: Tags,
        permission: 'catalog:view',
      },
    ],
  },
  {
    title: 'Cumplimiento',
    items: [{ href: '/audit', label: 'Auditoría', icon: ScrollText, permission: 'audit:view' }],
  },
];
