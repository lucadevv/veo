# design/ · Fuente de verdad visual

**`veo.pen`** es el plano de diseño de TODO VEO (Pencil, design-as-code: archivo de texto versionable).
Se edita con la app [Pencil](https://pencil.dev) y los agentes lo leen SOLO por el MCP `pencil`
(está cifrado — jamás con Read/grep). El flujo obligatorio de construcción fiel vive en
`apps/passenger/CLAUDE.md` §"Flujo de diseño".

El diseño LEGACY (PNGs/videos del diseño viejo pre-Pencil) se eliminó al completar la decisión
del dueño (2026-07-03): el `.pen` es la única fuente de verdad visual. Binarios pesados NO van
en git (regla del repo) — assets de producto van en MinIO referenciados.
