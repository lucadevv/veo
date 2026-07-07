import type { LucideIcon } from 'lucide-react';
import {
  Banknote,
  Car,
  Cctv,
  ClipboardCheck,
  Coins,
  MapPinned,
  Radar,
  Scale,
  ScrollText,
  ShieldAlert,
  Tags,
  TrendingUp,
  Truck,
  Undo2,
  UserCog,
  Users,
  UsersRound,
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
    // FLOTA reagrupada (rediseño de IA): Conductores + Vehículos + la cola unificada de Revisiones.
    // Conductores se mueve acá desde Operación (el alta/aprobación es gestión de flota, no operación en vivo).
    title: 'Flota',
    items: [
      { href: '/ops/drivers', label: 'Conductores', icon: Users, permission: 'drivers:view' },
      { href: '/fleet', label: 'Vehículos', icon: Truck, permission: 'fleet:view', exact: true },
      {
        href: '/fleet/reviews',
        label: 'Revisiones',
        icon: ClipboardCheck,
        permission: 'fleet:review',
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
    // FINANZAS = la OPERACIÓN del dinero (el flujo de la plata): liquidaciones + reembolsos + reconciliación.
    // Los 3 modos de precio se movieron a su propio grupo PRECIOS (config de cómo se cobra, no flujo).
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
        href: '/finance/refunds',
        label: 'Reembolsos',
        icon: Undo2,
        permission: 'finance:view',
      },
      {
        href: '/finance/reconciliation',
        label: 'Reconciliación',
        icon: Scale,
        permission: 'finance:view',
      },
    ],
  },
  {
    // PRECIOS — el HÍBRIDO de VEO (on-demand · oferta · carpooling): la config de cómo se cobra por cada
    // modelo, separada de Finanzas (operación del dinero). Cada modo es un carril de pricing distinto.
    title: 'Precios',
    items: [
      {
        href: '/finance/pricing',
        label: 'On-demand',
        icon: Coins,
        permission: 'pricing:view',
      },
      {
        href: '/finance/catalog',
        label: 'Por oferta',
        icon: Tags,
        permission: 'catalog:view',
      },
      {
        href: '/finance/carpooling',
        label: 'Carpooling',
        icon: UsersRound,
        permission: 'pricing:view',
      },
    ],
  },
  {
    title: 'Cumplimiento',
    items: [{ href: '/audit', label: 'Auditoría', icon: ScrollText, permission: 'audit:view' }],
  },
];
