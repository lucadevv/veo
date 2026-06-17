import type { EcosystemApp, EcosystemStat } from '@/domain/ecosystem';

/**
 * Contenido del hub. Es la ÚNICA fuente de datos: la UI se deriva de acá.
 * Para sumar una experiencia, se agrega una entrada — sin tocar componentes.
 *
 * NOTA: los `href` apuntan hoy a placeholders (`#…`). Cuando cada app se despliegue,
 * se cablean las URLs reales (o se inyectan por env) en este único lugar.
 */
export const ECOSYSTEM_APPS: readonly EcosystemApp[] = [
  {
    key: 'pasajero',
    name: 'Pasajero',
    theme: 'Midnight Motion · lima/negro',
    accent: 'lime',
    solid: true,
    description:
      'Pide con tu precio (estilo regateo), viaja con cámara y SOS, y comparte el viaje con tu familia.',
    features: [
      'Tú pones el precio',
      'Cámara + SOS',
      'Compartir con familia',
      'Stripe · Yape · Plin',
      'Control parental',
    ],
    icon: 'eye',
    links: {
      primary: { label: 'Prototipo clicable', href: '#pasajero-app' },
      secondary: { label: 'Lienzo de flujo', href: '#pasajero-flujo' },
    },
  },
  {
    key: 'conductor',
    name: 'Conductor',
    theme: 'Noche · cian/azul',
    accent: 'cyan',
    solid: true,
    description:
      'Registro con documentos y selfie, gate biométrico por turno, ofertas con contraoferta y ganancias.',
    features: [
      'Gate biométrico',
      'Oferta / contraoferta',
      'Modo destino',
      'Documentos + vencimientos',
      'Incentivos',
    ],
    icon: 'car',
    links: {
      primary: { label: 'Prototipo clicable', href: '#conductor-app' },
      secondary: { label: 'Lienzo de flujo', href: '#conductor-flujo' },
    },
  },
  {
    key: 'familia',
    name: 'Familia',
    theme: 'Web pública · navy/cian',
    accent: 'warm',
    solid: false,
    description:
      'Sin instalar nada: abre el link y acompaña el viaje en vivo — mapa, conductor, cámara y llegada.',
    features: [
      'Sin login',
      'Viaje en vivo',
      'Cámara del viaje',
      'Solo lectura',
      '7 estados de cierre',
    ],
    icon: 'family',
    links: {
      primary: { label: 'Prototipo clicable', href: '#familia-app' },
      secondary: { label: 'Lienzo de flujo', href: '#familia-flujo' },
    },
  },
  {
    key: 'admin',
    name: 'Admin',
    theme: 'El cerebro · RBAC',
    accent: 'neutral',
    solid: false,
    description:
      'Operación en vivo, cola de pánicos, conductores, flota, finanzas, video con doble auth y auditoría.',
    features: [
      'Pánicos en vivo',
      'Acceso a video (MFA)',
      'Liquidaciones',
      'Auditoría hash',
      'RBAC',
    ],
    icon: 'shield',
    links: {
      primary: { label: 'Prototipo clicable', href: '#admin-app' },
      secondary: { label: 'Lienzo de flujo', href: '#admin-flujo' },
    },
  },
];

/** Métricas del hero. */
export const ECOSYSTEM_STATS: readonly EcosystemStat[] = [
  { value: '4', label: 'Aplicaciones' },
  { value: '8', label: 'Entregables' },
  { value: 'S/', label: 'Stripe · Yape · Plin', mono: true },
  { value: '29733', label: 'Ley de datos' },
];
