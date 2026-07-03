# VEO — Especificaciones de Diseño · App CONDUCTOR

> **Para:** diseñador visual (Figma).
> **Fuente de verdad del QUÉ/PORQUÉ:** `VEO_BRIEF_DISENO.md` (este documento es el CÓMO visual).
> **App:** conductor de VEO (movilidad segura, Lima — Perú).
> **Plataforma:** **Android prioritario** (min SDK 26 / Android 8.0). **iOS en fase 3.**
> **Tema visual:** **"Noche"** — **azul eléctrico `#2D7FF9`** de acento (texto **BLANCO `#FFFFFF`** encima) sobre lienzo casi-negro azulado `#0A0B0F`. **Migración 2026-06: el acento `cyan` anterior (`#39BCDF`/`#00E5FF`) queda DEPRECADO.**
> **Tokens (valores reales del `driverTheme` en `@veo/ui-kit` `tokens/themes.ts` — la FUENTE DE VERDAD; este doc los transcribe):** `bg #0A0B0F` · `surface #14161C` · `surfaceElevated #1E212A` · `ink #F5F7FA` · `inkMuted #C4CBD6` · `inkSubtle #8A929E` · `border #1C1F27` · `borderStrong #2B2F3A` · `brand`/`accent`/`focus` **`#2D7FF9`** · `onBrand`/`onAccent` **`#FFFFFF`** · `success`/`safe #34D399` · `warn #F2AF48` · `danger #FF4D6A`. Se referenazul por NOMBRE de token, nunca por hex suelto.

---

## 0. Lo que tenés que entender antes de diseñar

Esta **NO es una app de consumo**. Es una **HERRAMIENTA DE TRABAJO**. El conductor la usa muchas horas, de noche, al volante, con el celular en un soporte, mirándola de reojo entre semáforos y bajo sol directo. Las consecuencias de diseño son no negociables:

- **Densa pero glanceable.** La información crítica (estado de turno, próxima maniobra, oferta entrante) se lee en **menos de 1 segundo**. Todo lo demás es secundario.
- **Legible al sol y de noche.** Modo noche por defecto, alto contraste (AA mínimo), nada de gris-sobre-gris para datos importantes.
- **Áreas táctiles grandes.** Targets ≥ **48 pt** (token `TOUCH_TARGET = 44` es el MÍNIMO absoluto; subilo a 48–56 en acciones que se tocan manejando: aceptar/rechazar viaje, "Llegué", "Completar").
- **Sobria, no juguetona.** Animación funcional (estado, atención), nunca decorativa-distractora. El conductor no está para "deleitarse", está para trabajar y cobrar.
- **Tono de copy:** español peruano **profesional**, directo, de respeto entre socios. "Conéctate", "Desconectarse", "tu cuenta de socio conductor", "tarifa estimada". Nada de jerga forzada ni diminutivos.

### 🔴 Dos reglas de SEGURIDAD que mandan sobre TODA decisión visual

> **REGLA 1 — Gate biométrico obligatorio por turno.**
> No se inicia turno sin liveness + match facial. **Sin bypass, sin override de UI, sin "modo demo".** **3 fallos = bloqueo de 1 hora** (solo la central destraba). Detalle en §3.

> **REGLA 2 — UI ENGAÑOSA EN PÁNICO (la más importante de esta app).**
> Cuando el pasajero dispara pánico, **el conductor NO se entera**. El backend NO le manda el evento: solo recibe un `trip:update` con estado **`CANCELLED` normal**. En el diseño está **PROHIBIDO**: UI roja especial, alertas, el texto "pánico", instrucciones, cambios de layout o cualquier señal que delate a la víctima. Una cancelación por pánico **tiene que verse idéntica a cualquier otra cancelación**. Detalle en §5 (TripActive) y nota destacada al final.

---

## 1. Sistema base

### 1.1 Tema y color
- Tema único **"Noche"** (modo oscuro por defecto — el conductor trabaja con poca luz). No hay modo claro.
- Fondo `bg`, tarjetas `surface`, sheets/inputs elevados `surfaceElevated`.
- **Acento de acción = `accent` = `brand` = azul eléctrico `#2D7FF9`.** Botón primario, anillos de captura, ruta en mapa (`routeColor`), focos, badges de marca. **El texto sobre el azul es BLANCO `#FFFFFF`** (`onAccent`/`onBrand`) — el azul tiene profundidad suficiente para texto blanco (a diferencia del `cyan` anterior, que pedía texto negro). Uso disciplinado: el azul ≤10% de la superficie, el resto es el lienzo oscuro.
- Semántica consistente con TODO el ecosistema VEO: **`success` (verde) = OK / a bordo / vigente**, **`warn` (amarillo) = por vencer / atención**, **`danger` (rojo) = error / vencido / cancelado**. (Ver excepción de pánico: el rojo de cancelación es el rojo NORMAL, no uno especial.)
- Nunca comunicar SOLO por color: todo estado lleva ícono + texto además del tono (accesibilidad AA, importa con guantes/sol).

### 1.2 Tipografía (token `variant`)
Grotesk del sistema. Contraste por **escala + peso**, no por color. Variantes disponibles:

| Variant | Tamaño / Interlínea | Peso | Uso |
|---|---|---|---|
| `display` | 40 / 52 | bold | Cifras hero (tarifa estimada en oferta, neto total) |
| `title1` | 24 / 38 | bold | Título de pantalla |
| `title2` | 24 / 38 | bold | Encabezado de bloque / cifra grande |
| `title3` | 20 / 32 | bold | Estado del viaje, subtítulos fuertes |
| `headline` | 18 / 28 | bold | "Listo para recibir viajes" |
| `body` / `bodyStrong` | 16 / 24 | regular / semibold | Cuerpo, valores en filas |
| `callout` | 16 / 24 | medium | Subtítulos, descripciones |
| `subhead` | 14 / 22 | medium | Labels de sección |
| `footnote` | 14 / 20 | regular | Metadatos, ayudas |
| `caption` | 12 / 16 | medium | Chips, micro-labels |
| `overline` | 12 / 16 | bold (+letterSpacing) | Etiquetas de estado en mayúsculas |

- **Cifras siempre `tabular`** (alineación de dígitos) en montos PEN, distancias, contadores, OTP. Es no negociable: los números bailan si no.
- Formato de moneda: `S/ 18.50` (helper `formatPEN`). Distancia `12.4 km`, duración `18 min`.

### 1.3 Espaciado y forma (tokens `spacing` / `radii`)
- Escala base 4 pt: `xs 4 · sm 8 · md 12 · lg 16 · xl 20 · 2xl 24 · 3xl 32 · 4xl 40 · 5xl 48`.
- Padding de pantalla: **20 pt** (`xl`) horizontal. Gap entre bloques: `xl`–`2xl`.
- Radios: tarjetas/inputs `lg 16` o `md 12`; sheets `xl 20`; chips/pills `pill 999`. **Nada sobre-redondeado.**
- Elevación: `level2` para overlays flotantes sobre mapa, `level3` para sheets prominentes (oferta entrante).

### 1.4 Áreas táctiles y motion
- Botones de acción primaria full-width, altura `lg`. Acciones que se tocan manejando ≥ 48–56 pt.
- Motion: `Reveal`/`Appear` (entrada sutil con fade+translate), `Pulse` (halo que respira en captura biométrica y "buscando viajes"), `CountdownRing` (oferta). **Todo respeta reduce-motion** (degrada a crossfade).

### 1.5 Patrón de estados (aplica a TODA pantalla con datos)
Toda pantalla que trae datos del backend implementa los 4 estados — diseñalos siempre:
- **Loading:** `Skeleton` con la silueta del contenido real (no spinner pelado).
- **Vacío:** `StateView` (título + descripción) o card de superficie con copy guía.
- **Error:** `Banner tone="danger"` con `errors.generic` + descripción + acción **"Reintentar"**.
- **Éxito:** el contenido. Confirmaciones puntuales con `Banner tone="success"`.

---

# FLUJOS

Mapa de navegación (brief §5.1): `Splash → Onboarding → Login → [Registro 4 pasos | UnderReview | MAIN TABS]`. Tabs: **Inicio · Ganancias · Viajes · Cuenta**. Full-screen sobre tabs: `ShiftStart · BiometricEnroll · TripIncoming · TripActive · Chat · Documents · Incentives · Support`.

---

## FLUJO 1 · Auth & Onboarding

### Splash (`SplashScreen.tsx`)
- **Propósito:** pantalla de arranque mientras el `RootNavigator` rehidrata la sesión (`status === 'bootstrapping'`). Marca y promesa.
- **Entrada / Salida:** entra al abrir la app. Sale automáticamente cuando el bootstrap resuelve → Onboarding, Login, Wizard, UnderReview o Tabs (el splash no navega).
- **Layout & jerarquía visual:** lienzo `bg` centrado. Detrás, una **ruta azul decorativa con glow** que se "dibuja" sola de abajo hacia arriba hasta un pin de destino. Al centro, wordmark **"VEO Conductores"** (escala+opacidad spring). Tagline abajo. Barra de progreso fina (72×4) al pie.
- **Componentes clave:** `VeoWordmark size="xl"`, ruta SVG animada (línea base `accent` 22% opacidad + línea fina `accent` sólida), pin destino + punto origen, track de progreso (`surfaceElevated`) con fill `accent`.
- **Estados:** sin estados de datos; es transitoria. Edge: si el bootstrap demora, la barra de progreso comunica avance (no se queda muerta). Reduce-motion → crossfade sin dibujo ni escala.
- **Interacciones & transiciones:** ninguna táctil. Transición de salida tipo `fade`.
- **Contenido & copy:** wordmark "VEO Conductores" · tagline **"Maneja. Gana. Protegido."**
- **Color & énfasis:** `accent` para ruta/pin/progreso; texto tagline `inkMuted`.

### Onboarding (`OnboardingScreen.tsx`)
- **Propósito:** presentar el valor a un conductor nuevo (ganancias + protección) antes de pedirle login. Una sola vez.
- **Entrada / Salida:** primera apertura sin onboarding completado. Salida: "Empezar" o "Saltar" → persiste flag → Login.
- **Layout & jerarquía visual:** carrusel horizontal paginado de **2 slides**. Arriba wordmark `sm`. Cada slide: ilustración line-art (ciudad + ruta azul que sube a un pin) ~200 alto, título `title1`, cuerpo `body inkMuted`. Slide 1 ("Ganancias") suma un **chip flotante "Ganancias de hoy"** con cifra `title2 tabular` y flecha azul. Dots animados al pie (el activo se ensancha y se tiñe `accent`). Footer fijo: "Saltar" (ghost) + "Siguiente/Empezar" (accent, dominante).
- **Componentes clave:** `ScrollView pagingEnabled`, `SlideArt` (earnings | protected: moneda S/ o escudo con check), `EarningsChip`, `Dot`, `Button` accent.
- **Estados:** sin datos. Edge: en el último slide el CTA cambia "Siguiente" → "Empezar".
- **Interacciones & transiciones:** swipe horizontal con paginado; tap "Siguiente" avanza con scroll animado. Reduce-motion acorta los dots.
- **Contenido & copy:** slide 1 = ganancias claras; slide 2 = "manejas protegido". CTAs: "Saltar", "Siguiente", "Empezar".
- **Color & énfasis:** `accent` en ilustración, chip y dot activo; CTA primaria accent.
- **Seguridad / nota especial:** a diferencia del pasajero, el onboarding del conductor **no incluye los 3 consentimientos Ley 29733** acá (el consentimiento de datos del conductor se gestiona en el alta/KYC). No agregar checkboxes de consentimiento en este carrusel.

### Login — teléfono + OTP / Face ID re-login (`LoginScreen.tsx`)
- **Propósito:** autenticar al conductor por teléfono peruano + OTP de 6 dígitos; o re-login rápido con biometría del dispositivo si ya hay token guardado.
- **Entrada / Salida:** tras Onboarding o en cold-start sin sesión. El éxito cambia el estado de sesión y el `RootNavigator` conmuta solo (la pantalla NO navega).
- **Layout & jerarquía visual:** dos pasos.
  - **Paso `phone`:** cabecera con **motivo de ruta azul** decorativo + wordmark inline `sm` + `title1` "Ingresa a VEO Conductores" + `callout` "Tu cuenta de socio conductor". Si hay biometría disponible → **tarjeta Face ID** (escudo-huella azul en círculo, título, cuerpo, botón accent "Ingresar con Face ID", botón secundario "Usar código en su lugar"). Divisor "o ingresa con tu número". Campo teléfono con **prefijo `+51` fijo** a la izquierda + helper. CTA accent `lg` full-width "Enviar código" (deshabilitado hasta teléfono válido, 9 dígitos).
  - **Paso `code`:** botón volver (IconButton surface) + `title1` "Código" + subtítulo "Te enviamos un código por WhatsApp a +51 ··· ··· 123" (teléfono enmascarado). **6 casillas OTP** (input oculto; cada caja `surfaceElevated`, la activa con borde `accent` 2px, "pop" sutil al recibir dígito). Helper o error. CTA accent "Verificar" + ghost "Cambiar número".
- **Componentes clave:** `RouteMotif`, `FaceIdGlyph`, tarjeta `Card variant="filled"`, `TextField` con `leftIcon` +51, `OtpField`/`OtpBox`, `Banner` (warn sesión expirada / danger error).
- **Estados:**
  - *Loading:* spinners en "Enviar código" (`requestOtp.isPending`) y "Verificar" (`login.isPending`), y en el botón Face ID.
  - *Error de teléfono:* inline "Número inválido" cuando hay dígitos y no valida.
  - *Error OTP:* casillas con borde `danger` + texto `danger` "Código inválido" (rol alert).
  - *Error de servidor:* `Banner danger` con `errors.generic` + detalle.
  - *Sesión expirada:* al entrar por expiración, `Banner warn` "Tu sesión expiró".
  - *Éxito:* la pantalla desaparece (conmuta el navigator).
  - *Edge — Face ID falla:* `Banner danger` dentro de la tarjeta; el conductor cae al flujo de número.
  - *Edge — biometría no disponible:* no se muestra la tarjeta Face ID; arranca directo en el campo de teléfono.
- **Interacciones & transiciones:** `Reveal` escalonado de los bloques. Cambio phone↔code sin pantalla nueva (mismo screen, branch de estado). Autofill de OTP por SMS (`oneTimeCode`).
- **Contenido & copy:** "Ingresa a VEO Conductores" · "Tu cuenta de socio conductor" · "Enviar código" · "Verificar" · "Cambiar número" · "Usar código en su lugar".
- **Color & énfasis:** `accent` en motivo, escudo, casilla activa y CTAs. Errores `danger`, avisos `warn`.
- **Seguridad / nota especial:** OTP propio, timeout 10 min, reenvío con cooldown 30 s (ver pasajero §4.2). **Canal de entrega (ADR-012 §1.2/§6):** **WhatsApp PRINCIPAL** (Meta Cloud API tras puerto `WhatsAppSender`, excepción §0.7 acotada) con **fallback automático a SMS soberano** (SMPP). _⏳ Estado: WhatsApp es el objetivo (ADR-012); hoy el código entrega por SMS — el puerto `WhatsAppSender` está pendiente de construir._ El re-login biométrico es del **dispositivo** (no es el gate de turno, que es facial server-side).

---

## FLUJO 2 · Registro — Wizard 4 pasos (`RegistrationNavigator.tsx`)

Wizard **reanudable**: abre en el paso donde quedó (`currentStep` persistido). Transición horizontal `slide_from_right`; el back retrocede al paso anterior. Estados de alta: `not_started → in_progress → in_review → approved/rejected`. **Patrón compartido de todos los pasos:**
- Header `RegistrationHeader` (logo + "alas" + guiño bandera Perú según paso) con back.
- `RegistrationProgress` (barra de 4 segmentos, el actual en `accent`).
- Línea "Paso X de 4" (`caption inkMuted`).
- `title1` + `callout` de intro.
- `Banner danger` de error de servidor arriba del formulario.
- Footer fijo: CTA accent full-width (deshabilitado hasta completar los campos requeridos del paso).
- Campos `RegistrationField` con ícono `accent` a la derecha; **errores inline por campo** (se limpian al editar).

### Paso 1 — Datos personales (`PersonalDataScreen.tsx`)
- **Propósito:** capturar datos tal como figuran en el DNI. `PATCH /drivers/me/personal`.
- **🔒 Seguridad / PII del DNI (Ley 29733) — decisión del dueño:** el DNI del **Driver** se persiste **CIFRADO en reposo** (secret-box AES-256-GCM, reversible), **NO hash**. Razón: compliance debe **MOSTRARLO** al operador para verificación manual contra el documento antes de aprobar, y un hash (una sola vía) rompería esa verificación. identity-service es dueño del dato y del secret: descifra en el borde gRPC antes de mandar el DNI al admin-bff (gateado Compliance+); el secret no se reparte a otros servicios. El `PATCH /drivers/me/personal` **NO** devuelve el DNI crudo al conductor — lo devuelve **enmascarado** (últimos 4 dígitos). Nota: el "DNI = solo hash" de FOUNDATION §5 aplica al **`User`** (matching interno irreversible, nunca se muestra), **no** al **`Driver`** (compliance lo muestra). Decidido por el dueño.
- **Entrada / Salida:** entrada del wizard (paso 1). Éxito → `setCurrentStep(2)` → Vehículo.
- **Layout & jerarquía visual:** 3 campos en columna: **Nombre completo** (ícono cuenta), **DNI** (number-pad, máx 11, ícono documento), **Fecha de nacimiento** (number-pad, máx 14, ícono calendario).
- **Componentes clave:** `RegistrationField` ×3, `Reveal from="scale"` escalonado.
- **Estados:** *Loading:* spinner en "Continuar". *Error de campo:* mensaje bajo el campo (`registration.personal.errors.*`). *Error servidor:* banner. *Éxito:* avanza. *Edge:* CTA bloqueado hasta que los 3 campos tengan contenido.
- **Contenido & copy:** título "Tus datos" + subtítulo "como aparecen en tu DNI". Placeholders concretos (nombre, "12345678", "DD/MM/AAAA").
- **Color & énfasis:** íconos de campo `accent`; barra de progreso paso 1 activa.

### Paso 2 — Vehículo (`VehicleScreen.tsx`)
- **Propósito:** registrar el vehículo de trabajo. `POST/GET /drivers/vehicles`.
- **Entrada / Salida:** desde paso 1. Éxito → paso 3 (Documentos).
- **Layout & jerarquía visual:** **selector tipo de vehículo Auto / Moto** (`VehicleTypeSelector`, segmentado grande), luego campos: **Placa** (mayúsculas, máx 8), fila **Marca + Año** (year number-pad máx 4), **Modelo** (mayúsculas). Si ya hay un vehículo registrado → en vez del formulario, **`VehicleStatusCard`** con su estado y el CTA pasa a "Continuar" (no se re-registra).
- **Componentes clave:** `VehicleTypeSelector`, `RegistrationField`, `VehicleStatusCard`.
- **Estados:** *Loading:* "Registrar vehículo" con spinner. *Error de campo:* inline (placa/marca/año/modelo). *Servidor:* banner. *Vehículo existente:* card de estado + subtítulo distinto ("Ya registraste tu vehículo"). *Edge:* con vehículo existente el CTA siempre habilita (solo avanza).
- **Contenido & copy:** "Tu vehículo" · subtítulo según exista o no. CTA "Registrar vehículo" / "Continuar".
- **Color & énfasis:** tipo seleccionado en `accent`; resto `surface`.
- **Seguridad / nota especial:** moto-taxi es categoría local de primera clase (Auto/Moto explícito); el tipo define qué viajes ofrece el dispatch más adelante.

### Paso 3 — Documentos (`DocumentsScreen.tsx` — registration)
- **Propósito:** subir Licencia, SOAT y Tarjeta de propiedad. Gating: **no se avanza sin los 3**.
- **Entrada / Salida:** desde paso 2. Éxito (3 subidos) → paso 4 (KYC).
- **Layout & jerarquía visual:** lista de 3 **`DocumentUploadCard`** (Licencia/ícono doc · SOAT/ícono escudo · Tarjeta de propiedad/ícono auto), cada una con su estado (pendiente / subido) y un **chip de estado de servidor** (`vigente`→success, `por_vencer`→warn, `vencido/rechazado`→danger, `en_revision`→neutral). Tap abre un **sheet de captura** (`RegistrationDocumentSheet`): número de documento y, para Licencia, **fecha de vencimiento obligatoria**. Nota al pie con ícono (i) sobre formatos aceptados.
- **Componentes clave:** `DocumentUploadCard` ×3, `RegistrationDocumentSheet`, `InfoGlyph`.
- **Estados:** *Loading de chips:* mientras rehidrata `GET /drivers/me/documents`. *Subiendo:* card `busy`. *Error de subida:* mensaje dentro del sheet. *Error de carga de servidor:* `Banner warn`. *Éxito:* chip "subido". *Edge:* CTA "Continuar" bloqueado + guarda defensiva (jamás avanza con documentos faltantes).
- **Contenido & copy:** "Tus documentos" + subtítulo. Labels: "Licencia de conducir", "SOAT", "Tarjeta de propiedad". "Subido" / "Pendiente". Nota de formatos.
- **Color & énfasis:** íconos `accent`; chips por semántica (success/warn/danger).
- **Seguridad / nota especial:** la Licencia, además de registrarse, **alimenta el onboarding del conductor** (driverOnboardRequest) — por eso exige vencimiento.

### Paso 4 — Verificación de identidad / KYC facial (`IdentityVerificationScreen.tsx`)
- **Propósito:** captura de **una selfie** que cierra el alta. Captura nativa con cámara frontal. El backend corre **liveness PASIVO (anti-spoofing single-frame · PAD)** sobre esa única foto — **sin frames extra, sin reto, sin lag** (a diferencia del liveness ACTIVO por challenge del gate de turno). Si la captura es un ataque de presentación (foto/pantalla) el enrol se **rechaza** (no se guarda biometría).
- **Entrada / Salida:** desde paso 3. Al confirmar la foto → envío → el backend pasa el alta a `in_review` → `UnderReview`.
- **Layout & jerarquía visual:** intro centrada. **Anillo guía facial** (`FaceGuideRing`, ~260) con dos **chips de guía** flanqueando: "Buena luz" (sol) y "Mira al frente" (rostro), ambos con borde `accent` translúcido. Botón de captura circular grande (anillo `accent`). Al capturar → **preview circular** de la foto (borde `accent` + badge de check verde) y footer cambia a **"Repetir" (secondary) + "Confirmar" (accent)**. Aviso de privacidad con ícono escudo `success`.
- **Componentes clave:** `FaceGuideRing`, `HintChip` ×2, `CapturePreview`, botón de captura, `Banner`.
- **Estados:** *Capturando:* spinner en el botón + label "Capturando…". *Preview:* foto + acciones repetir/confirmar. *Enviando:* spinner en "Confirmar". *Spoof (anti-spoofing pasivo rechaza):* `Banner danger` "Necesitamos verte en persona" → "Parece una foto o una pantalla. Apuntá la cámara a tu rostro real e intentá de nuevo." (kind `spoof`, distinto de `face`). *Rostro no procesable (0/2+ rostros o sin rostro):* `Banner warn` "No detectamos bien tu rostro" (kind `face`). *Cámara no disponible:* `Banner warn` (título+cuerpo de "no disponible"). *Error genérico:* `Banner danger`. *Edge:* sin cámara/permiso el flujo degrada con aviso, no rompe.
- **Contenido & copy:** "Verificación de identidad" · subtítulo distinto en captura vs preview · "Tomar foto" / "Capturando…" / "Repetir" / "Confirmar" · chips "Buena luz" / "Mira al frente" · privacidad ("tus datos se procesan de forma segura").
- **Color & énfasis:** `accent` en anillo/chips/botón; check de éxito `success`; privacidad escudo `success`.
- **Seguridad / nota especial:** motor biométrico **propio (ONNX)**, soberanía de datos (no SaaS). Es captura de **enrolamiento del alta** con liveness **PASIVO** (anti-spoofing single-frame), distinta del gate de turno (liveness **ACTIVO** por challenge). Defensa en profundidad: el enrol corre el PAD; el operador, al aprobar, corre el **face-match de la selfie contra DNI Y licencia (brevete)** — `approve()` exige que **AMBOS** cotejos se hayan EJECUTADO (binding más fuerte), aunque el veredicto final lo decide el operador. **DEUDA:** el umbral/índice del PAD son DEFAULTS — calibrar con set real/spoof antes de prod (un índice mal puesto INVIERTE el veredicto).

### UnderReview (`UnderReviewScreen.tsx`)
- **Propósito:** confirmar que el alta se envió y está en revisión. El conductor NO opera todavía.
- **Entrada / Salida:** estado `in_review`. Permanece acá hasta que **el backend** decida `approved/rejected` (nunca se aprueba localmente). "Entendido" es solo acuse, no cambia estado.
- **Layout & jerarquía visual:** wordmark `sm` con guiño Perú, **ilustración line-art** de portapapeles con checks + reloj, `title1` "Estamos revisando tus datos" + subtítulo. **Checklist tipo timeline**: Datos personales ✓ · Vehículo ✓ · Documentos ✓ · Verificación facial → "En revisión" (spinner). Footer: "Entendido" (secondary) + "Contactar soporte" (ghost, ícono salvavidas → abre mail de soporte).
- **Componentes clave:** `ReviewClipboard`, `ChecklistRow` (marker verde con check / marker azul con spinner), `VeoWordmark peru`.
- **Estados:** estática (no consume datos en vivo; el gate la mantiene). Los pasos completados en `success`, el pendiente con spinner `accent`. *Edge — rechazado:* el navigator NO muestra esta pantalla; manda al wizard al paso con datos a corregir.
- **Contenido & copy:** "Estamos revisando tus datos" + "Te avisaremos cuando esté aprobado". "Entendido" / "Contactar soporte".
- **Color & énfasis:** checks `success`, pendiente `accent`, fondo sobrio.
- **Seguridad / nota especial:** la aprobación es **decisión exclusiva del backend**; no diseñar ningún CTA que "apruebe" o "fuerce" el ingreso.

---

## FLUJO 3 · Inicio de turno — 🔴 GATE BIOMÉTRICO

> Regla 1. El conductor pasa por acá **cada vez que se conecta**. Es la barrera de seguridad de la app. Layout premium compartido por `BiometricGate`.

### ShiftStart (`ShiftStartScreen.tsx`)
- **Propósito:** verificar liveness + match facial contra un challenge del backend (BLINK / SMILE / NOD / TURN_LEFT / TURN_RIGHT) antes de habilitar el turno. **Obligatorio, sin bypass.**
- **Entrada / Salida:** desde el Dashboard al tocar "Conéctate". Éxito → turno `AVAILABLE` → vuelve al Dashboard. Si el conductor no está enrolado → redirige a BiometricEnroll.
- **Layout & jerarquía visual (`BiometricGate`):** top bar con back + título "Iniciar turno". Centro: **escudo `accent` en círculo `surfaceElevated`** con **halo azul que respira** (`Pulse`); durante la captura el halo **se acelera e intensifica** y el escudo late. `title2` "Verificación de identidad" + `callout` explicativo. Banner de resultado bajo el copy. Footer: CTA primaria `lg` full-width (captura).
- **Componentes clave:** `BiometricGate`, `Pulse` (halo + escudo), `IconShield`, `Banner` de resultado.
- **Estados:**
  - *Idle:* CTA "Iniciar verificación".
  - *Capturando:* `loading` (spinner + label "Verificando…"), halo intensificado.
  - *Éxito:* `Banner success` "Verificación exitosa ({score})" → cierra y conecta.
  - *Rechazado (no match / liveness falla):* `Banner danger` "No pudimos verificarte" + motivo.
  - *🔴 Bloqueo (3 fallos):* `Banner danger` **"Verificación bloqueada"** + **"Por seguridad, intenta de nuevo en 1 hora o contacta a la central."** El CTA NO debe ofrecer reintento que evada el bloqueo.
  - *Cámara no disponible / frame-grabber:* `Banner warn` "Cámara no disponible".
  - *Backend no disponible:* `Banner warn`.
  - *Edge — GPS sin fix:* no bloquea el gate (el gate es facial); el GPS se resuelve en el Dashboard.
- **Interacciones & transiciones:** captura nativa de 8–12 frames; la UI solo dispara y refleja fase. Halo como feedback de "procesando".
- **Contenido & copy:** "Iniciar turno" · "Verificación de identidad" · "Por seguridad, debes verificar tu rostro (prueba de vida) antes de iniciar el turno." · resultados arriba.
- **Color & énfasis:** `accent` (escudo/halo/CTA), `success` éxito, `danger` rechazo/bloqueo, `warn` indisponibilidad.
- **Seguridad / nota especial (CRÍTICA):** **PROHIBIDO** diseñar cualquier "saltar verificación", "modo offline", "reintentar ahora" que evada el bloqueo de 1 h, o un override. El estado de bloqueo es terminal en la app: **solo la central destraba**. El score se muestra pero NO es accionable por el conductor.

### BiometricEnroll (`BiometricEnrollScreen.tsx`)
- **Propósito:** enrolar el rostro del conductor **una sola vez** (requisito previo del gate de turno). Captura una foto y la registra.
- **Entrada / Salida:** desde ShiftStart (si no está enrolado) o desde Cuenta ("Registrar rostro"). Éxito → vuelve atrás.
- **Layout & jerarquía visual:** **idéntico a ShiftStart** (mismo `BiometricGate`: escudo+halo, copy, banner, CTA) para coherencia. Cambia solo el texto: "Registrar rostro".
- **Componentes clave:** `BiometricGate`, `useBiometricEnroll`.
- **Estados:** *Idle* CTA "Registrar rostro" · *Capturando* "Capturando…" · *Éxito* `Banner success` "Rostro registrado" · *Falla* `Banner danger` · *Cámara/backend no disponible* `Banner warn`.
- **Contenido & copy:** "Registrar rostro" + cuerpo explicando que se usará para iniciar turno.
- **Color & énfasis:** igual al gate (azul/success/danger/warn).
- **Seguridad / nota especial:** distinguir visualmente poco de ShiftStart **a propósito** (mismo lenguaje de seguridad), pero el copy deja claro que esto es alta de rostro, no inicio de turno.

---

## FLUJO 4 · Dashboard / Turno (`DashboardScreen.tsx`)

- **Propósito:** centro de operación. Mapa en vivo + estado de turno (`OFFLINE → AVAILABLE → ON_BREAK → ON_TRIP`), ganancias rápidas, conexión/desconexión, zonas de demanda. Tab "Inicio".
- **Entrada / Salida:** tab principal tras aprobación. Navega a ShiftStart (conectarse), TripActive (viaje en curso), Ganancias, Cuenta.
- **Layout & jerarquía visual:** **mapa a pantalla completa** (`MapShell` + `AppMap`) como fondo. Overlays flotantes:
  - **Top:** píldora-tarjeta de saludo "Hola, Conductor" con avatar (→ Cuenta) a la izquierda; a la derecha **`StatusPill` de estado de turno** + **pill de tipo de vehículo activo (Auto/Moto)** + **toggle "Zonas de demanda"** (ícono llama; activo = relleno `accent`).
  - **Bottom dock (prioridad de render):** error > viaje activo > en línea > desconectado.
    - *Desconectado/pausa:* `Card` con selector de vehículo, KPIs de ganancias (neto total + por liquidar), link "Ver ganancias", y **CTA dominante `lg` "Conéctate"** (ícono power) — o "Reanudar" si venía de pausa.
    - *En línea (`AVAILABLE`):* `Card` "Listo para recibir viajes" con **punto verde pulsante**, selector de vehículo (editable), KPIs en vivo, "Pausar" (secondary) + "Desconectarse" (ghost).
    - *Viaje activo:* `Card` "Tienes un viaje en curso" + CTA accent "Ver viaje activo".
- **Componentes clave:** `MapShell`, `AppMap` (con `heatCells`), `StatusPill`, `VehicleTypeSelector`, KPIs `Appear`, `Pulse` (punto live + demanda), `DemandLegend`, `BottomSheet` de confirmación de desconexión.
- **Estados:**
  - *Loading:* skeleton en el dock; mapa montado igual.
  - *Error de turno:* `Banner danger` + "Reintentar" en el dock.
  - *AVAILABLE:* pill `success` pulsante "Listo · Buscando viajes"; mapa interactivo; mapa de calor disponible.
  - *ON_BREAK:* pill `warn` "En pausa"; CTA "Reanudar".
  - *ON_TRIP:* pill `accent`; dock muestra acceso al viaje.
  - *OFFLINE:* mapa **atenuado** (capa `bg` 55%), pin oculto, KPIs + "Conéctate".
  - *Edge — GPS sin fix:* sin pin del conductor; mapa centrado en `LIMA_CENTER`; no se inventa ubicación. Fixes corruptos (NaN) se ignoran, conservando el último válido.
  - *Demanda vacía:* `Banner info` "Sin zonas de alta demanda ahora". *Demanda error:* `Banner warn`.
- **Interacciones & transiciones:** toggle demanda pinta heatmap (solo en línea, sin viaje, con ubicación). Desconectarse abre `BottomSheet` de confirmación (cancelar / "Terminar turno" en `danger`). KPIs con `Appear` escalonado.
- **Contenido & copy:** "Hola, Conductor" · pill "Listo · Buscando viajes" / "Desconectado" / "En pausa" · "Listo para recibir viajes" · "Conéctate" / "Reanudar" / "Pausar" / "Desconectarse" · KPIs "Neto total" / "Por liquidar" (este último en `warn`) · "Zonas de demanda".
- **Color & énfasis:** `success` (disponible/live), `accent` (vehículo activo, demanda on, ver viaje), `warn` (pausa, por liquidar), `danger` (terminar turno). Mapa de ruta/demanda en azul.
- **Seguridad / nota especial:** el tipo de vehículo se bloquea durante un viaje (`ON_TRIP`). Foreground Service de Android mantiene GPS+WebRTC vivos (no es UI, pero condiciona que el estado "en línea" sea confiable).

---

## FLUJO 5 · Viaje (entrante → activo)

### TripIncoming — oferta entrante 12 s (`TripIncomingScreen.tsx`)
- **Propósito:** presentar una oferta de viaje con **cuenta atrás** y decisión aceptar/rechazar. **Pre-aceptación: datos del pasajero OCULTOS** (regla 5).
- **Entrada / Salida:** llega por socket (`incomingOffer`), se abre full-screen (sin gesto de cierre). Aceptar → `TripActive`. Rechazar / expirar → vuelve a disponible.
- **Layout & jerarquía visual:** mapa de fondo **atenuado** (scrim `overlay`, centrado en Lima, sin pin — no hay coordenadas reales aún). Top: `StatusPill warn` "Vence en {n} s" (live). **Sheet inferior prominente** (`elevation level3`, radio `xl`): grabber, **`CountdownRing` azul** con ping radar (`Pulse`), `title2` "Nuevo viaje", badge "Reservado" si es programado. Cuerpo: **foco = tarifa estimada `display` grande** + tarjeta de ruta recojo→destino (riel con dots, sin direcciones reales) mostrando **Distancia** y **Duración**. Banner info si es **Modo niño**. Acciones: **"Rechazar" (ghost)** + **"Aceptar" (accent, dominante, full)**.
- **Componentes clave:** `CountdownRing`, `Pulse` (radar), `StatusPill`, tarjeta de ruta con riel, `Banner` (childMode/expirado/error).
- **Estados:**
  - *Loading del trip:* `Skeleton` 140 dentro del sheet.
  - *Error del trip:* `StateView` + "Reintentar".
  - *🔴 Expirado (12 s a 0):* ring en estado expirado, pill `danger` "Oferta expirada", `Banner danger`, **botón Aceptar deshabilitado**. El conductor vuelve a disponible.
  - *Aceptando/Rechazando:* spinners en los botones.
  - *Error al aceptar/rechazar:* `Banner danger`.
  - *Edge — Modo niño:* `Banner info` "Viaje con Modo niño".
- **Interacciones & transiciones:** sheet entra con `SlideInDown` (curva drawer) o fade en reduce-motion. El anillo decrece con el tiempo restante real (denominador = mayor countdown observado, no fijo). Sin gesto de descarte (decisión explícita).
- **Contenido & copy:** "Nuevo viaje" · "Vence en 12 s" / "Oferta expirada" · "Tarifa estimada" · "Distancia" / "Duración" · "Reservado" · "Aceptar" / "Rechazar".
- **Color & énfasis:** `accent` (ring/radar/aceptar), `warn`→`danger` en el contador, tarifa en `ink` grande.
- **Seguridad / nota especial (regla 5):** **NUNCA** mostrar nombre, teléfono, foto ni dirección exacta del pasajero antes de aceptar. Solo tarifa + distancia + duración (+ flag modo niño). Diseñar el sheet asumiendo que esos datos NO existen todavía.

### TripActive — viaje en curso (`TripActiveScreen.tsx`)
- **Propósito:** navegar el viaje turn-by-turn y avanzar la máquina de estados (`ASSIGNED→ACCEPTED→ARRIVING→ARRIVED→IN_PROGRESS→COMPLETED`), con chat al pasajero. Publica cámara+micrófono del habitáculo durante `IN_PROGRESS`.
- **Entrada / Salida:** tras aceptar la oferta o desde el dock del Dashboard. Completar/cancelar → vuelve al Dashboard (`popToTop`).
- **Layout & jerarquía visual:**
  - **Header:** TopBar "Viaje activo" + back + **botón de chat con badge de no leídos**.
  - **Mapa (hero, ~mitad superior):** `MapShell live` (pill "EN VIVO" cuando `ARRIVING`/`IN_PROGRESS`) con la **polyline de ruta azul**. Sobre el mapa, **banner de próxima maniobra** (`ManeuverBanner`) cuando hay ruta; si no, card de estado con ícono navegación.
  - **Sheet inferior (~46% alto):** fila del **pasajero** (avatar — online en `IN_PROGRESS` — + estado del viaje + **tarifa** a la derecha), `StatusPill` del estado (tono según fase), lista de pasos `RouteStepsList` + botones de navegación externa, y **una acción principal según el estado**:
    - `ACCEPTED` → "Voy en camino" (accent)
    - `ARRIVING` → "Llegué al punto" (accent)
    - `ARRIVED` → "Iniciar viaje" (`safe`/verde)
    - `IN_PROGRESS` → "Completar viaje" (`safe`/verde)
    - `COMPLETED`/`CANCELLED` → "Ir al inicio"
    - mientras esté activo y no `IN_PROGRESS` → "Cancelar viaje" (ghost)
- **Componentes clave:** `MapShell live`, `AppMap` con `routeCoordinates`, `ManeuverBanner`, `RouteStepsList`, `ExternalNavButtons`, `ChatButton`, `Avatar`, `StatusPill`, `BottomSheet` (cancelar / código modo niño).
- **Estados:**
  - *Loading:* skeleton 240 con header.
  - *Error del trip:* `StateView` + "Reintentar".
  - *Confirmando asignación (ASSIGNED→ACCEPTED):* botón "Confirmando asignación…" loading; si falla el poll → botón "Reintentar".
  - *Ruta no disponible:* `Banner warn` "No se pudo obtener la ruta" (degrada a navegación externa).
  - *Error de acción:* `Banner danger`.
  - *Modo niño:* `Banner info` + al "Iniciar viaje" abre `BottomSheet` que pide **código de 4–6 dígitos** (no inicia sin código válido).
  - *Cancelación:* `BottomSheet` con motivo (TextField multiline) + "Cancelar viaje" en `danger`.
  - *Edge — GPS sin fix:* mapa sin pin del conductor, centrado en Lima; la ruta igual se pinta.
- **Interacciones & transiciones:** cada transición de estado re-renderiza la acción con `Appear` (key por estado). La acción principal es **una sola y grande** (glanceable al volante). Chat en `slide_from_right`.
- **Contenido & copy:** "Viaje activo" · estados ("En camino", "Llegando", "Llegaste", "En viaje", "Completado", "Cancelado") · "Voy en camino" / "Llegué al punto" / "Iniciar viaje" / "Completar viaje" / "Cancelar viaje" · "Tarifa" · "Motivo de cancelación".
- **Color & énfasis:** `accent` (ir/llegar, ruta, maniobra), `success`/`safe` (iniciar/completar, a bordo), `danger` (cancelar). `StatusPill` por fase (neutral→brand→accent→success→danger).
- **Seguridad / nota especial — 🔴 PÁNICO (regla 2, LA MÁS IMPORTANTE):**
  - Durante `IN_PROGRESS` se **publica cámara+micrófono del habitáculo** a la sala `trip:<id>` (LiveKit). En la UI del conductor esto es **discreto** (el indicador "EN VIVO" del mapa es de tracking, no de "estás siendo grabado"); no diseñar un mensaje alarmante de grabación.
  - **Cuando el pasajero dispara pánico, el conductor recibe un `trip:update` con estado `CANCELLED` y nada más.** La pantalla debe mostrar **exactamente la misma cancelación que cualquier otra**: `StatusPill danger` "Cancelado" + botón "Ir al inicio". **PROHIBIDO**: cualquier UI roja especial, alerta, vibración distinta, texto "pánico/emergencia/alerta", instrucción, cambio de layout o tratamiento diferente al de una cancelación común. **Una cancelación por pánico y una cancelación normal son visualmente INDISTINGUIBLES.** Esto protege a la víctima — es requisito de diseño, no preferencia.

### Chat con el pasajero (`ChatScreen.tsx`)
- **Propósito:** mensajería breve durante el viaje (coordinar recojo). Solo mientras el viaje está activo.
- **Entrada / Salida:** desde el botón de chat de TripActive (con badge). Back vuelve al viaje.
- **Layout & jerarquía visual:** header "Chat" + back. Lista de **burbujas** (`MessageBubble`, propias vs pasajero), **respuestas rápidas** (`QuickReplies`: "Estoy llegando", "Llegué", "Te espero") sobre el composer, y **composer** inferior (input multilínea `surface` + botón enviar `tinted`/azul, deshabilitado vacío). Al entrar marca leído (limpia badge).
- **Componentes clave:** `FlatList` de `MessageBubble`, `QuickReplies`, composer con `IconButton` enviar.
- **Estados:** *Loading:* skeletons de burbujas. *Vacío:* `StateView` "Aún no hay mensajes". *Error de envío:* `Banner danger`. *Viaje inactivo (completado/cancelado):* `Banner warn` "Este viaje ya terminó" + composer y quick replies deshabilitados (placeholder "No disponible"). *Edge:* máx 500 caracteres por mensaje.
- **Interacciones & transiciones:** auto-scroll al pie con cada mensaje; `KeyboardAvoidingView`; quick replies envían directo.
- **Contenido & copy:** plantillas "Estoy llegando" / "Llegué" / "Te espero" · placeholder "Escribe un mensaje" · "Este viaje ya terminó".
- **Color & énfasis:** burbuja propia en `accent`/tinted, ajena en `surface`; botón enviar activo `accent`, inactivo `surface`.
- **Seguridad / nota especial:** el chat se cierra con el viaje (no se conversa con viajes cerrados); coherente con la regla de no exponer datos fuera del viaje.

---

## FLUJO 6 · Ganancias (`EarningsScreen.tsx`)

- **Propósito:** transparencia de ingresos: resumen (neto + liquidaciones) y desglose (hoy/semana). Tab "Ganancias".
- **Entrada / Salida:** tab. También accesible desde Dashboard y Cuenta.
- **Layout & jerarquía visual:** título "Ganancias". **`SegmentedTabs`** "Resumen | Desglose".
  - *Resumen:* **`EarningsHeroCard`** con neto total grande (`display tabular`) + stats reales, y **lista de liquidaciones** (`PayoutRow`: monto, período, estado).
  - *Desglose:* dos **`BreakdownCard`** (HOY y SEMANA) con neto destacado y componentes.
- **Componentes clave:** `SegmentedTabs`, `EarningsHeroCard`, `PayoutRow`, `BreakdownCard`, `Appear` escalonado.
- **Estados:** *Loading:* skeletons con forma de hero/cards/filas. *Error:* `Banner danger` + "Reintentar". *Vacío (sin payouts):* card "Aún no tienes liquidaciones". *Éxito:* datos. *Edge — payout retenido (HELD):* estado en `danger` "Retenido"; PAID→success, PROCESSING→accent, pendiente→warn.
- **Interacciones & transiciones:** cambio de pestaña instantáneo; `Appear` por fila.
- **Contenido & copy:** "Ganancias" · "Resumen" / "Desglose" · "Liquidaciones" · "Hoy" / "Esta semana" · estados de payout (Pagado/En proceso/Pendiente/Retenido) · montos en `S/`.
- **Color & énfasis:** neto en `ink` grande; estados de payout por semántica; acento solo en "en proceso".
- **Seguridad / nota especial:** ninguna específica. Mantener cifras `tabular` y claras (confianza = transparencia).

---

## FLUJO 7 · Documentos & Incentivos

### Documentos operativos (`DocumentsScreen.tsx` — documents)
- **Propósito:** gestionar documentos vigentes para operar (distinto del paso 3 del alta): ver vencimientos y registrar/actualizar. Stack (no tab), accesible desde Cuenta.
- **Entrada / Salida:** desde Cuenta → "Documentos". Back vuelve.
- **Layout & jerarquía visual:** header con back + "Documentos". **Banner de atención** arriba: `warn` "Tienes N documento(s) por revisar" o `success` "Todos tus documentos están vigentes". Lista en card de **`DocumentRow`** (tipo, número, vencimiento, `StatusPill` por estado, **resaltado si requiere atención** con color `warn`/`danger`). Footer: CTA primaria "Agregar documento" (ícono +) que abre `RegisterDocumentSheet`.
- **Componentes clave:** `DocumentRow`, `RegisterDocumentSheet`, `Banner` de atención, `StatusPill`.
- **Estados:** *Loading:* skeletons de filas. *Error:* `Banner danger` + "Reintentar". *Vacío:* card "Aún no registraste documentos". *Atención:* banner warn + filas resaltadas. *Todo ok:* banner success. *Edge — vencido/rechazado:* fila resaltada en `danger`; por vencer en `warn`.
- **Interacciones & transiciones:** tap en fila abre el sheet en modo edición; agregar abre en modo nuevo. `Appear` por fila.
- **Contenido & copy:** "Documentos" · "Todos tus documentos están vigentes" / "Tienes N por revisar" · "Vence el {fecha}" / "Sin vencimiento" · "Agregar documento".
- **Color & énfasis:** semántica de vencimientos (success/warn/danger); CTA accent.
- **Seguridad / nota especial:** vencimientos son compliance (Ley/operación); el resaltado debe ser inequívoco (color **+ ícono + texto**, nunca solo color).

### Incentivos (`IncentivesScreen.tsx`)
- **Propósito:** mostrar incentivos activos (metas/recompensas) con progreso y vigencia. Motivador pero sobrio.
- **Entrada / Salida:** desde Cuenta o Dashboard. Back vuelve.
- **Layout & jerarquía visual:** header "Incentivos". `Banner info` con intro + línea "N activos". Lista de **`IncentiveCard`** (cada una: meta, **barra de progreso `accent`**, recompensa, vigencia; orden activo→completado→vencido).
- **Componentes clave:** `IncentiveCard` (progreso), `Banner info`, `Appear`.
- **Estados:** *Loading:* 2 skeletons 180. *Error:* `StateView` + "Reintentar". *Vacío:* `StateView` "Aún no tienes incentivos" + cuerpo. *Éxito:* lista. *Edge — completado/vencido:* card en estado distinto (completado celebra discreto, vencido apagado).
- **Interacciones & transiciones:** `Appear` por card.
- **Contenido & copy:** "Incentivos" · intro motivadora · "N activos" · estados por card.
- **Color & énfasis:** progreso y meta en `accent`; completado `success`; vencido neutralizado.
- **Seguridad / nota especial:** ninguna.

---

## FLUJO 8 · Perfil / Cuenta & Soporte

### Cuenta / Perfil (`ProfileScreen.tsx`)
- **Propósito:** identidad del conductor, estado de cumplimiento/KYC, accesos a secciones y cierre de sesión. Tab "Cuenta".
- **Entrada / Salida:** tab. Enlaces a Documentos, BiometricEnroll, Ganancias, Incentivos, Viajes, Soporte.
- **Layout & jerarquía visual:** título "Cuenta". **`ProfileIdentityCard`** (avatar grande, teléfono, **chip de rating** con promedio + conteo 30 días, indicador online). **Banner de cumplimiento** (`warn` "Te falta: …" / `success` "Tu documentación está al día"). Bloque **Verificación** (`Card` con `ListItem` + `StatusPill`): Estado actual · KYC (VERIFIED→success / else warn) · Antecedentes (CLEARED→success / else warn). Bloque **Documentos** (lista con pills válido/ inválido). **Card de accesos rápidos** (`ProfileLinkRow` con ícono `accent`): Documentos · Registrar rostro · Ganancias · Incentivos · Historial de viajes · Soporte. Al pie: **"Cerrar sesión" (danger)** con confirmación en `BottomSheet`.
- **Componentes clave:** `ProfileIdentityCard`, `ListItem` + `StatusPill`, `ProfileLinkRow`, `Banner`, `BottomSheet` de logout.
- **Estados:** *Loading:* skeletons de las tres zonas. *Error:* `StateView` + "Reintentar". *Cumplimiento incompleto:* banner warn con lista de faltantes. *KYC/antecedentes pendientes:* pills `warn`. *Logout:* sheet de confirmación (cancelar / "Cerrar sesión" danger). *Edge — sin documentos:* texto "al día" en el bloque.
- **Interacciones & transiciones:** `Appear` escalonado por bloque; filas → navegación.
- **Contenido & copy:** "Cuenta" · "Verificación de identidad" / "Antecedentes" / "Estado actual" · "Tu documentación está al día" / "Te falta: …" · "Registrar rostro" · "Cerrar sesión".
- **Color & énfasis:** `success` (al día/verificado/cleared), `warn` (faltante/pendiente), `danger` (documento inválido, logout), `accent` (íconos de accesos).
- **Seguridad / nota especial:** "Registrar rostro" lleva al enrolamiento biométrico; el estado KYC/antecedentes es informativo (lo decide el backend, no se edita acá).

### Soporte (`SupportScreen.tsx`)
- **Propósito:** centro de ayuda: FAQ, reportar problema (ticket) y ver tickets propios.
- **Entrada / Salida:** desde Cuenta (o desde un viaje, con `tripId` para adjuntarlo). Back vuelve.
- **Layout & jerarquía visual:** header "Soporte". **Hero** (`surfaceElevated`, ícono salvavidas `accent`) con título + cuerpo + **CTA accent "Reportar un problema"** (abre `ReportProblemSheet`). Sección **FAQ** (`FaqAccordion`: iniciar turno, pagos, documentos…). Sección **"Mis tickets"** (lista de `TicketRow` con estado).
- **Componentes clave:** hero card, `FaqAccordion`, `TicketRow`, `ReportProblemSheet`, `Appear`.
- **Estados:** *Tickets loading:* skeleton 120. *Error:* `Banner danger` + "Reintentar". *Vacío:* card "Aún no tienes tickets". *Éxito:* lista. *Edge — desde viaje:* el formulario ofrece adjuntar el `tripId`.
- **Interacciones & transiciones:** acordeón FAQ; sheet de reporte; `Appear` por ticket.
- **Contenido & copy:** "Soporte" · "¿Necesitas ayuda?" · "Reportar un problema" · "Preguntas frecuentes" · "Mis tickets" · "Aún no tienes tickets".
- **Color & énfasis:** `accent` en hero/CTA; estados de ticket por semántica.
- **Seguridad / nota especial:** ninguna.

### (Referencia) Historial de viajes — `TripHistoryScreen.tsx`
Tab "Viajes". No estaba en la lista mínima pero existe: lista de viajes pasados con `TripsEmptyState` (vacío), estados loading/error estándar. Diseñar con el mismo patrón de listas (card + filas + estados). Sin notas de seguridad.

---

## 🔴 NOTA DE SEGURIDAD DESTACADA (releer antes de entregar Figma)

1. **Gate biométrico (Regla 1) — sin escape visual.** En `ShiftStart` no debe existir NINGÚN control que permita saltar, mockear o evadir la verificación, ni reintentar dentro del bloqueo de 1 h. El bloqueo es un estado terminal en la app; solo la central destraba. El `score` se muestra pero no es accionable.

2. **Pánico invisible (Regla 2) — la regla que manda sobre la estética.** El conductor **nunca** se entera de un pánico. En `TripActive`, una cancelación disparada por pánico llega como `CANCELLED` normal y debe verse **idéntica** a cualquier otra cancelación:
   - ❌ Prohibido: UI roja especial, banner/alerta de emergencia, la palabra "pánico/emergencia/SOS/alerta", instrucciones al conductor, vibración o sonido distinto, cambio de layout, badge o ícono especial.
   - ✅ Obligatorio: misma `StatusPill danger` "Cancelado" + misma acción "Ir al inicio" que una cancelación común.
   - **Criterio de aceptación:** poné lado a lado el mockup de "cancelación normal" y el de "cancelación por pánico" — **tienen que ser indistinguibles**. Si se distinguen, el diseño es incorrecto y pone en riesgo a la víctima.

3. **Pre-aceptación sin datos del pasajero (Regla 5).** En `TripIncoming`, antes de aceptar: **solo** tarifa estimada + distancia + duración (+ flag modo niño). Sin nombre, teléfono, foto ni dirección exacta. Los datos del pasajero aparecen recién en `TripActive`, tras aceptar.

4. **Grabación discreta.** La publicación de cámara+micrófono del habitáculo en `IN_PROGRESS` no se comunica con UI alarmante. El indicador "EN VIVO" del mapa es de tracking del viaje, no un cartel de "estás siendo grabado".

---

_Referencias de código (driver-app): `features/auth/presentation/screens/*`, `navigation/RegistrationNavigator.tsx`, `features/registration/presentation/screens/*`, `features/shift/presentation/{screens,components}/*`, `features/trips/presentation/screens/*`, `features/chat|earnings|documents|ops|profile|support/presentation/screens/*`, `navigation/RootNavigator.tsx`. Tokens: `@veo/ui-kit/src/tokens/{themes,spacing,radii,typography,motion}.ts`. Reglas no negociables: `veo-driver-app/CLAUDE.md`._
