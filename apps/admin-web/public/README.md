# `public/` — assets estáticos del admin-web

Next.js sirve este directorio desde la raíz (`/archivo.ext`).

## Video del login

El login (`/login`) reproduce un video de fondo a sangre completa. El componente
`src/components/auth/login-brand-video.tsx` consume UN solo archivo:

| Archivo            | Uso                                  | ¿Obligatorio? |
| ------------------ | ------------------------------------ | ------------- |
| `login-hero.mp4`   | Video de fondo (H.264, mudo)         | No\*          |

\* Sin el archivo, el login cae limpio al color de fondo (`bg-bg`) — nunca se rompe.

### Por qué `object-cover` (y NO `contain`)
El video llena el viewport a CUALQUIER tamaño sin franjas negras. Un 16:9 sobre una
pantalla 16:9 no recorta nada; sobre otra relación recorta los bordes (el sujeto queda
centrado). `object-contain` deja vacíos negros cuando el viewport no calza con el aspect
del video — por eso NO se usa.

### Recomendaciones del asset
- **Aspect**: 16:9 (los monitores de operación son 16:9 → sin recorte).
- **Duración**: 8–20 s en loop sin corte visible.
- **Tono**: sobrio, de marca (ciudad/movilidad/seguridad). Mudo, sin audio.
- **Peso**: < 3–4 MB (es un login). Resolución 1920×1080 mínimo.
