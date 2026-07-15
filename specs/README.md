# VEO — Especificaciones de Diseño

> Paquete de entrega para el diseñador visual. Cada documento describe una app de VEO **por flujo → por pantalla**, con propósito, layout, jerarquía, componentes, estados, interacciones, copy en español peruano y tokens de color.

## Cómo leer este paquete

1. **Empezá por el brief:** [`../docs/VEO_BRIEF_DISENO.md`](../docs/VEO_BRIEF_DISENO.md) — el QUÉ y el PORQUÉ del producto, los 4 actores, la paleta de colores completa y los principios de diseño. Es la fuente de verdad compartida; los specs lo referencian, no lo repiten.
2. **Después, el spec de la app que vayas a diseñar.** Cada uno es autónomo.

## Los 4 documentos

| App           | Documento                                          | Plataforma                           | Tema                                                  | Pantallas                                    |
| ------------- | -------------------------------------------------- | ------------------------------------ | ----------------------------------------------------- | -------------------------------------------- |
| **Pasajero**  | [`VEO_SPEC_PASAJERO.md`](./VEO_SPEC_PASAJERO.md)   | iOS + Android                        | "Noche" — azul de marca `#2D7FF9` sobre lienzo oscuro | 24                                           |
| **Conductor** | [`VEO_SPEC_CONDUCTOR.md`](./VEO_SPEC_CONDUCTOR.md) | Android (iOS fase 3)                 | "Noche" — azul de marca `#2D7FF9` sobre lienzo oscuro | 19                                           |
| **Familia**   | [`VEO_SPEC_FAMILIA.md`](./VEO_SPEC_FAMILIA.md)     | Web pública, sin login, mobile-first | Azul de marca `#2D7FF9` (OKLCH, light+dark)           | Landing + viaje en vivo + estados terminales |
| **Admin**     | [`VEO_SPEC_ADMIN.md`](./VEO_SPEC_ADMIN.md)         | Web dashboard (7 roles RBAC)         | Azul de marca `#2D7FF9` (OKLCH, sobrio/data-first)    | Login/MFA + 7 secciones                      |

## Plantilla por pantalla (común a los 4 docs)

Cada pantalla se especifica con: **Propósito · Entrada/Salida · Layout & jerarquía visual · Componentes clave · Estados (loading/vacío/error/éxito + edge cases reales) · Interacciones & transiciones · Contenido & copy · Color & énfasis · Seguridad/nota especial.**

## Reglas de seguridad transversales (NO negociables en el diseño)

Estas tres atraviesan todo el ecosistema. El diseñador tiene que respetarlas siempre:

1. **El pánico es invisible por diseño.**
   - _Pasajero:_ se dispara con triple botón de volumen, **sin ninguna UI** — para no alertar al agresor.
   - _Conductor:_ cuando el pasajero entra en pánico, el conductor **solo ve una cancelación normal**. Prohibido: UI roja, alertas, mensajes o cambios de layout. La pantalla de cancelación por pánico y la de cancelación común deben ser **indistinguibles**.
   - _Familia:_ la vista de "viaje cancelado" también debe verse idéntica ante un pánico.
2. **Gate biométrico del conductor.** Verificación facial (liveness + match) obligatoria por turno, sin bypass. 3 fallos = bloqueo de 1 hora.
3. **Accesibilidad reforzada.** Contraste AA, áreas táctiles ≥44pt (≥48 en conductor), y **nunca comunicar un estado crítico solo por color** (los pánicos en admin llevan icono + texto + color).

## Identidad de color en una mirada

- **Una sola marca:** **azul de marca `#2D7FF9`** (texto blanco encima) sobre lienzo oscuro azulado `#0A0B0F`, en las 4 superficies. Lo que cambia entre apps es el **uso**, no el color.
- **Pasajero / Conductor** = "Noche", móvil dark. El conductor **no se diferencia por color** (mismo azul); se distingue por app icon, densidad glanceable y targets más grandes (herramienta de trabajo).
- **Familia / Admin** = web, mismo azul de marca en **OKLCH**, soportan light + dark. Acento ≤10%: lo vivo/accionable (familia) o acción primaria + foco (admin).
- **Semántica compartida:** verde = seguridad/OK · rojo = peligro/pánico · amarillo = advertencia. El acento azul es disciplinado (≤10% de la superficie).

> Detalle completo de tokens en el brief, §3. **Migración 2026-06:** los acentos previos (lima `#C8F230`, cyan `#00E5FF`/`#39BCDF`, navy-como-marca) quedan DEPRECADOS.
