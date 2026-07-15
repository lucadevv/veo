# @veo/web-hub

Landing del **ecosistema VEO**: una sola página que presenta las 4 experiencias
(Pasajero, Conductor, Familia, Admin) y enlaza a cada una. Es la cara pública del
proyecto — implementa el diseño `VEO - Inicio.html` del handoff de Claude Design.

> Marca VEO = azul `#2D7FF9` sobre lienzo oscuro `#0E1014` (token `--lime`, nombre heredado
> del tema viejo "Midnight Motion"; el valor ya es el azul de marca). Comparte el azul de marca
> con `admin-web`/`family-web`, que derivan el mismo `#2D7FF9` a OKLCH en `@veo/shared-config`.

## Stack

- Next.js 14 (App Router) · React 18 · TypeScript
- Tailwind CSS 3 con tokens propios en `globals.css` (única fuente de verdad)
- Fuentes auto-hospedadas vía `next/font` (Space Grotesk · Inter · JetBrains Mono) — sin CDN, compatible con la CSP `self`

## Desarrollo

```bash
pnpm install                       # desde la raíz del monorepo
pnpm --filter @veo/web-hub dev     # http://localhost:5200
```

## Arquitectura

Página estática, sin estado ni dependencias de runtime. La UI se **deriva de datos**:

```
src/
├── domain/ecosystem.ts      Tipos del dominio (EcosystemApp, EcosystemStat, AccentName)
├── data/ecosystem.ts        SSOT del contenido: las 4 apps + stats (agregar app = agregar dato)
├── theme/accents.ts         Tokens cromáticos por acento (lima/cian/warm/neutral), un solo lugar
├── lib/cn.ts                Merge de clases Tailwind
├── components/              Un componente por responsabilidad (SRP)
│   ├── app-icon.tsx         Registro de íconos SVG (fieles al diseño)
│   ├── brand-mark.tsx       Wordmark VEO + punto lima
│   ├── site-header.tsx      Encabezado
│   ├── hero.tsx             Hero + StatList
│   ├── stat-list.tsx        Métricas
│   ├── app-card.tsx         Tarjeta de una app (resuelve color desde su acento)
│   ├── feature-chips.tsx    Chips de features
│   ├── app-grid.tsx         Grilla que compone AppCards
│   ├── theme-legend.tsx     Leyenda de color
│   └── site-footer.tsx      Pie
└── app/                     layout (fuentes/metadata) · page (composición) · globals.css (tokens)
```

**Principios aplicados:** SRP (un componente, una responsabilidad), OCP (sumar una app
no toca componentes, solo datos), SSOT de color (variables CSS + tokens de acento).

## Pendiente

Los `href` de las tarjetas son placeholders (`#…`). Cuando cada app se despliegue, se
cablean las URLs reales en `data/ecosystem.ts` (o se inyectan por variable de entorno).
