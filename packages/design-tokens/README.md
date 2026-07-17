# @veo/design-tokens

Tokens semánticos de la identidad **Trust** de VEO — la **única fuente de hex** del sistema. TS puro, platform-agnostic (cero imports de RN/DOM/Node en `src/`).

## Quién consume

| Consumidor | Cómo |
| --- | --- |
| `@veo/ui-kit` (RN passenger + driver) | `themes.ts` importa `trustColors` y arma ambos temas light desde el canon |
| Apps web (admin-web, family-web, web-hub) | `packages/shared-config/tailwind/tokens.css`, **generado** desde este paquete |

## Regenerar el CSS

```bash
pnpm --filter @veo/design-tokens generate:css
```

Escribe `packages/shared-config/tailwind/tokens.css` (Trust LIGHT como `:root`). El spec `test/tokens.spec.ts` falla si el CSS commiteado quedó desincronizado del canon — nunca editar ese archivo a mano.

## Canon

`trustColors` = el `passengerColors` histórico de ui-kit + 3 correcciones ratificadas por el dueño (2026-07-16): `success`/`safe` #00C853 en todo el sistema (`accentStrong` #009624 para montos), `inkMuted` #647386 unificado, `info` alineado a la familia #0097CE. Con esto **passenger ≡ driver** en valores.

La paleta NOCHE histórica del conductor (`driverDarkColors`) vive intacta en `@veo/ui-kit` por si se reintroduce un toggle día/noche.
