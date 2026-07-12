import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  CalendarCheck,
  Car,
  ClipboardCheck,
  Film,
  Gavel,
  Headphones,
  KeyRound,
  Layers,
  Navigation,
  Radar,
  Receipt,
  Scale,
  ShieldCheck,
  Siren,
  Tag,
  TrendingUp,
  User,
  Users,
  Video,
  Wallet,
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

// Iconos y labels fieles al T/AdminSidebar de veo.pen; hrefs/permisos = rutas reales del app (RBAC).
export const NAV: NavGroup[] = [
  {
    title: 'Operación',
    items: [
      { href: '/ops', label: 'En vivo', icon: Activity, permission: 'ops:view', exact: true },
      { href: '/ops/metrics', label: 'Métricas', icon: TrendingUp, permission: 'ops:view' },
      { href: '/ops/trips', label: 'Viajes', icon: Navigation, permission: 'trips:view' },
      {
        href: '/ops/operators',
        label: 'Operadores',
        icon: Headphones,
        permission: 'operators:view',
      },
      {
        href: '/ops/dispatch-radius',
        label: 'Radios de dispatch',
        icon: Radar,
        permission: 'dispatch:view',
      },
    ],
  },
  {
    title: 'Flota',
    items: [
      { href: '/ops/drivers', label: 'Conductores', icon: User, permission: 'drivers:view' },
      { href: '/fleet', label: 'Vehículos', icon: Car, permission: 'fleet:view', exact: true },
      {
        href: '/fleet/reviews',
        label: 'Revisiones',
        icon: ClipboardCheck,
        permission: 'fleet:review',
      },
      {
        href: '/fleet/inspections',
        label: 'Inspecciones',
        icon: CalendarCheck,
        permission: 'fleet:review',
      },
    ],
  },
  {
    title: 'Seguridad',
    items: [
      { href: '/security/panics', label: 'Pánicos', icon: Siren, permission: 'panics:view' },
      {
        href: '/security/live-wall',
        label: 'Cámaras en vivo',
        icon: Video,
        permission: 'live:view',
      },
      { href: '/media', label: 'Acceso a video', icon: Film, permission: 'media:view' },
    ],
  },
  {
    title: 'Finanzas',
    items: [
      {
        href: '/finance',
        label: 'Liquidaciones',
        icon: Wallet,
        permission: 'finance:view',
        exact: true,
      },
      {
        href: '/finance/refunds',
        label: 'Reembolsos',
        icon: Receipt,
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
    title: 'Precios',
    items: [
      { href: '/finance/pricing', label: 'Precios', icon: Tag, permission: 'pricing:view' },
      {
        href: '/finance/catalog',
        label: 'Ofertas de servicio',
        icon: Layers,
        permission: 'catalog:view',
      },
      {
        href: '/finance/carpooling',
        label: 'Carpooling',
        icon: Users,
        permission: 'pricing:view',
      },
    ],
  },
  {
    title: 'Cumplimiento',
    items: [{ href: '/audit', label: 'Auditoría', icon: ShieldCheck, permission: 'audit:view' }],
  },
  {
    title: 'Gobierno',
    items: [
      {
        href: '/gobierno/permisos',
        label: 'Permisos y visibilidad',
        icon: KeyRound,
        permission: 'gobierno:manage',
      },
      {
        href: '/gobierno/politicas',
        label: 'Políticas',
        icon: Gavel,
        permission: 'gobierno:manage',
      },
    ],
  },
];
