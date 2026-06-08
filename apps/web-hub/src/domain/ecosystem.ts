/**
 * Modelo de dominio del hub. Define QUÉ es una app del ecosistema y un stat,
 * sin acoplarse a cómo se pintan. Los componentes dependen de estas abstracciones
 * (DIP), no de literales sueltos. Para agregar una app, se extiende el dato
 * (ver `data/ecosystem.ts`); los componentes no se tocan (OCP).
 */

/** Acento semántico de cada app. Su color real se resuelve en `theme/accents.ts`. */
export type AccentName = 'lime' | 'cyan' | 'warm' | 'neutral';

/** Ícono de marca de cada app. El registro vive en `components/app-icon.tsx`. */
export type IconName = 'eye' | 'car' | 'family' | 'shield';

/** Un destino navegable (prototipo clicable, lienzo de flujo, app desplegada…). */
export interface AppLink {
  readonly label: string;
  readonly href: string;
}

/** Una de las cuatro experiencias del ecosistema VEO. */
export interface EcosystemApp {
  readonly key: string;
  readonly name: string;
  /** Etiqueta descriptiva del tema, p. ej. "Midnight Motion · lima/negro". */
  readonly theme: string;
  readonly accent: AccentName;
  /** Si el ícono y el CTA primario van rellenos con el acento (true) o fantasma (false). */
  readonly solid: boolean;
  readonly description: string;
  readonly features: readonly string[];
  readonly icon: IconName;
  readonly links: {
    readonly primary: AppLink;
    readonly secondary: AppLink;
  };
}

/** Una métrica del hero (4 Apps, Ley 29733, etc.). */
export interface EcosystemStat {
  readonly value: string;
  readonly label: string;
  /** Renderiza el valor en tipografía monoespaciada (p. ej. "S/"). */
  readonly mono?: boolean;
}
