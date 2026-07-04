# VEO — Especificaciones de Diseño · App PASAJERO

> **Para:** diseñador visual (Figma).
> **App:** VEO Pasajero · **Plataforma:** iOS + Android (React Native, New Architecture).
> **Tema visual:** **"Noche"** — **azul eléctrico de marca `#2D7FF9`** (texto **BLANCO `#FFFFFF`** encima) sobre lienzo casi-negro azulado `#0A0B0F`. **Migración 2026-06: el acento lima anterior (`#C8F230`, "Midnight Motion") queda DEPRECADO.**
> **Lema:** _"Yo veo. Tú vas seguro."_ · **Mercado:** Lima, Perú · Español peruano.
>
> **Fuente de verdad de color y principios:** `../docs/VEO_BRIEF_DISENO.md` (§3.1 paleta pasajero, §9 principios). **No repito la paleta acá: referenciala.** En este doc uso los **nombres de token** del brief (`bg`, `surface`, `surfaceElevated`, `ink`, `inkMuted`, `inkSubtle`, `border`, `borderStrong`, `accent`/`brand`, `onAccent`, `success`/`safe`, `warn`, `danger`, `focus`, `overlay`, `routeColor`, `routeGlowColor`).
>
> Este documento define el **QUÉ, la JERARQUÍA y los ESTADOS**, no píxeles exactos. La creatividad de layout fino es del diseñador. Todo lo de acá está **verificado contra el código real** (rutas citadas por pantalla).

---

## 0. Cómo leer este documento

- Está **organizado por flujo** (7 flujos). Dentro de cada flujo, una **subsección por pantalla** con plantilla fija.
- Cada pantalla cita su **archivo real** (`features/<feature>/presentation/screens/<X>Screen.tsx`).
- **Seguridad primero:** cada vez que una pantalla toca seguridad/privacidad lo verás marcado en **Seguridad / nota especial**. Reglas innegociables resumidas en §1.5.

---

## 1. Sistema base de la app

### 1.1 Tema
- Único tema: **oscuro** ("Noche"). No hay modo claro en pasajero.
- Fondo de app = `bg`. Tarjetas = `surface`. Sheets, inputs y elementos elevados = `surfaceElevated`. Scrim de modales/sheets = `overlay`.
- El **acento azul de marca es escaso y caro**: se reserva para **1 acción primaria por pantalla**, el dibujo de ruta en el mapa (`routeColor` + halo `routeGlowColor`) y micro-acentos de marca. Cuando el azul rellena, el texto encima es **blanco** (`onAccent`). Si todo es azul, nada es azul.
- El **rojo `danger`** está reservado para **SOS / pánico** y acciones destructivas (cancelar viaje, eliminar, cerrar sesión, derecho al olvido). Nunca como decoración.
- El **verde `success`/`safe`** comunica confianza y estados OK (contacto verificado, modo niño activo, pago confirmado, KYC aprobado, "alerta enviada"). Principio del brief: _la seguridad se siente (verde), no se grita (rojo)_ — salvo en pánico real.

### 1.2 Tipografía (sugerida, sobria, mobile)
El kit expone **roles de tipografía** (no fuentes exóticas). Proponé una familia **sans geométrica/neutra de sistema ampliado**: **Inter** o **SF Pro / Roboto** como base, con un dígito **tabular** para precios, ETAs, OTP y contadores (el código usa `tabular` en todos esos lugares).

| Rol (variant del kit) | Uso |
|---|---|
| `display` | Títulos hero de pantalla (Auth, Profile setup, Panic, montos de pago) |
| `title1` / `title2` / `title3` | Encabezados de sección y de tarjeta |
| `bodyStrong` | Énfasis dentro de cuerpo, labels de fila |
| `body` / `callout` | Texto corrido, subtítulos |
| `subhead` | Etiquetas de sección (gris `inkMuted`) |
| `footnote` / `caption` | Ayudas, metadatos, helpers, pills |
| `label` | Eyebrows en mayúsculas (ej. onboarding) |

- **Tabular obligatorio** en: precios PEN, ETA en minutos, OTP, cuenta regresiva de reenvío, montos, IDs de pánico, teléfono.
- Jerarquía por **peso + tamaño + color**, no por color solo (accesibilidad).

### 1.3 Grilla, espaciado, forma
- El kit usa una **escala de espaciado** `xs / sm / md / lg / xl` y **radios** `sm / md / lg / xl / pill`. Respetala; no inventes valores sueltos.
- **Padding lateral de pantalla:** `xl` (márgenes generosos, respira).
- **Tarjetas:** radio `md`; sheets de mapa con esquinas superiores radio `xl` + **grabber** (barra `borderStrong`).
- **Botón primario:** `fullWidth`, `size="lg"`, anclado al **footer** de la pantalla (patrón `SafeScreen footer`).
- **Pills/chips:** radio `pill`, borde `border`, fondo `surface`.
- **Elevación:** niveles `level1`/`level2` para overlays sobre el mapa (pill de ubicación, chips, FAB).

### 1.4 Tono de copy (español peruano)
- Cálido, directo, claro, **sin jerga técnica**. Tuteo neutro peruano ("¿A dónde vamos?", "Confirmar viaje", "Listo").
- Nunca alarmista (salvo el botón SOS). La seguridad tranquiliza.
- Localismos correctos: **Yape, Plin**, **moto** y **auto** como categorías, soles **S/**.
- Microcopy honesto: si algo no está disponible, se dice claro y se ofrece reintento (el código nunca inventa datos).

### 1.5 Accesibilidad (no opcional)
- **Contraste AA** mínimo en todo texto. El azul de marca sobre el lienzo oscuro pasa para texto grande/acento/UI; texto largo va en `ink`/`inkMuted`.
- **Áreas táctiles ≥ 44pt** en todo control (botones, IconButton, chips, filas).
- **Nunca comunicar solo por color**: todo estado lleva texto/ícono además del color (ej. StatusPill con label + dot; "REC" con texto).
- `accessibilityRole` / `accessibilityLabel` / `accessibilityState` en cada control (ya presentes en código: checkbox de consentimiento, reenvío OTP, etc.).
- **Reduce-motion**: todas las animaciones tienen variante estática. El diseñador debe entregar el estado "sin movimiento" de splash, anillos que respiran, parallax y dots.

### 1.6 Reglas de seguridad innegociables (resumen — detalle en cada pantalla)
1. **El pánico automático es INVISIBLE.** Triple botón de volumen, detección nativa en background, **sin UI, sin confirmación, sin cambio de layout**. Ante coacción NO se delata a la víctima. (`usePanicAutoTrigger`).
2. **SOS manual = rojo `danger`**, fullscreen, siempre accesible en viaje activo.
3. **Indicador "REC" siempre visible** cuando hay cámara de cabina (tono `danger`, `live`, texto + dot).
4. **Modo niño:** el código nunca se muestra en la app del conductor; acá se ingresa enmascarado.
5. **KYC:** anillo/óvalo que **respira** (liveness activo) + badge "Capturando" visible (privacidad: la persona ve que la cámara está activa).
6. **Biometría** degrada seguro: si el equipo no soporta Face ID/huella, no bloquea.

### 1.7 Componentes globales del kit (los vas a reusar en todo el doc)
`SafeScreen` (shell con footer fijo) · `Button` (variants: `accent` / `primary` / `secondary` / `ghost` / `danger`, tamaños `sm`/`md`/`lg`) · `IconButton` · `Card` (`outlined`/`elevated`/`filled`) · `ListItem` (title/subtitle/leading/trailing/chevron) · `TextField` · `Banner` (tonos `danger`/`success`/`safe`/`warn`/`info`) · `StatusPill` (tonos + `dot` + `live`) · `BottomSheet` · `Avatar` · `Skeleton` · `MapShell` + `AppMap` · `DriverCard` · `SosButton` · `RoutePin` · `RideOptionRow` · `OriginDestinationField` · `SearchField` · `VeoWordmark` · `RouteMotif` (ruta azul punteada animada) · estados `LoadingState` / `EmptyState` / `ErrorState`.

---

# FLUJO 1 · Onboarding & Auth

Mapa: `Splash → Onboarding → Auth (phone→OTP) → CompleteProfile → Main`. Cold-start con sesión → `BiometricLock`. La conmutación de stacks la hace `RootNavigator` por **estado derivado** (no hay navegación imperativa: el diseñador piensa en estados, no en botones "siguiente pantalla").

### Splash (`SplashScreen.tsx`)
- **Propósito:** ocupar el tiempo de rehidratación de sesión con una entrada de marca elegante.
- **Entrada / Salida:** primer frame de cold-start → el navigator decide destino real (Onboarding / Auth / BiometricLock / Main).
- **Layout & jerarquía visual:** **centro** domina: wordmark "VEO" grande + **RouteMotif** (ruta azul punteada que se dibuja) justo debajo, tagline gris debajo. **Abajo (anclado):** loader azul tipo "barrido" en pista `surfaceElevated`.
- **Componentes clave:** `VeoWordmark size="xl" color="ink"` · `RouteMotif animated` · tagline `Text callout inkMuted` · loader segment azul sobre pista pill.
- **Estados:** único estado (transitorio). **Reduce-motion:** wordmark sin escala, loader con segmento estático.
- **Interacciones & transiciones:** entrada por opacidad + escala (0.92→1, spring) del grupo hero; ruta se dibuja sola; loader oscila en bucle. Sin gestos.
- **Contenido & copy:** wordmark "VEO" + tagline `splashTagline` (sugerencia: _"Yo veo. Tú vas seguro."_).
- **Color & énfasis:** `bg` de fondo, wordmark en `ink`, ruta + loader en `accent`.
- **Seguridad / nota especial:** ninguna.

### Onboarding (`OnboardingScreen.tsx`)
- **Propósito:** presentar el valor (seguridad, precio claro) y capturar los **3 consentimientos obligatorios (Ley N.° 29733)**.
- **Entrada / Salida:** primer uso (sin flag de onboarding) → al **aceptar** persiste el flag y el navigator pasa a Auth.
- **Layout & jerarquía visual:** **carrusel horizontal de 3 slides** paginado. Cabecera: wordmark `sm` centrado + pill de paso ("2 de 3") a la derecha (desde slide 2). **Footer fijo:** dots animados (píldora azul) + acciones.
  - **Slide 1 · Seguridad:** ilustración `SafetyArt` centrada, eyebrow azul en mayúsculas, título `display` centrado, cuerpo `inkMuted`.
  - **Slide 2 · Precio claro:** ilustración `PriceMapArt`, título `title1` alineado izquierda, dos `VehicleOption` (Moto destacada con borde `accent` + Auto) mostrando nombre/ETA/precio (muestra, no cotización real).
  - **Slide 3 · Consentimientos:** ilustración `ConsentArt`, título + subtítulo, etiqueta de sección, **3 filas-checkbox** (`ConsentRow`: card presionable, check azul cuando activo) + fila legal con ícono escudo.
- **Componentes clave:** ScrollView paginado con **parallax sutil** por capa · `AnimatedDots` · `VehicleOption` · `ConsentRow` (checkbox) · `Button accent` / `Button ghost`.
- **Estados:**
  - **Slides 1–2:** footer con `Saltar` (ghost, salta al slide 3) + `Siguiente` (accent).
  - **Slide 3:** footer con **"Aceptar y continuar"** (accent) **deshabilitado hasta marcar los 3** consentimientos (`allAccepted`).
  - Sin los 3 checks no avanza. El registro de consentimiento al backend es **best-effort** (no bloquea).
- **Interacciones & transiciones:** swipe horizontal con paginado; parallax de ilustración ligado al scroll; dots como píldora que se estira; check con pop. Reduce-motion: sin parallax, dots estáticos.
- **Contenido & copy (sugerido):**
  - Slide 1 eyebrow: "SEGURIDAD"; título: "Tu familia te ve llegar"; cuerpo: "Cara del conductor, placa, ruta y cámara en vivo. Nada oculto."
  - Slide 2: "Elige tu VEO"; "Precio claro antes de subir, sin sorpresas." · Moto "S/ 7 · 4 min" · Auto "S/ 12 · 6 min".
  - Slide 3: "Antes de empezar"; consentimientos: "Acepto el tratamiento de mis datos", "Acepto la cámara en cabina durante el viaje", "Acepto compartir mi ubicación". Legal: "Ley N.° 29733 de Protección de Datos Personales."
  - CTA: "Aceptar y continuar" · "Saltar" · "Siguiente".
- **Color & énfasis:** acento azul en eyebrow, borde de Moto destacada, check activo y dots. CTA primaria `accent`. Texto largo `inkMuted`.
- **Seguridad / nota especial:** **gate legal Ley 29733** — los 3 consentimientos son condición dura. Diseñá el estado disabled del CTA de forma evidente (no engañar al usuario haciéndolo creer que puede avanzar).

### Auth — Login multi-método (`AuthScreen.tsx`)
- **Propósito:** ingresar a VEO. El login es **multi-método** (ADR-012, ratificado): **Google OAuth · Sign in with Apple (iOS) · correo+contraseña (argon2id) · teléfono+OTP**, con **account-linking** (un mismo `User` puede tener varios métodos vinculados). El **teléfono + OTP de 6 dígitos** es el **camino feliz para Perú** (mercado masivo, sin correo). La verificación de cada método vive **server-side** (firma JWKS de Google / Apple, argon2.verify, OTP); el cliente nunca se autodeclara autenticado.
- **Entrada / Salida:** desde Onboarding → al verificar (cualquier método), la sesión pasa a `authenticated` y el navigator avanza a CompleteProfile (o Main si el perfil ya está completo).
- **Layout & jerarquía visual:** dos pasos en la misma pantalla.
  - **Selector de método (entrada):** botones de **Google**, **Sign in with Apple** (solo iOS), **correo+contraseña** y **teléfono** (camino feliz PE). El teléfono abre el paso de OTP descrito abajo; los demás siguen su propio sub-flujo (OAuth en Custom Tab/ASWebAuthenticationSession, correo con campo de password). _⏳ Estado: hoy el código entrega el camino feliz (teléfono+OTP); los métodos restantes se construyen lote por lote (ADR-012 §7)._
  - **Paso teléfono:** cabecera con badge de marca azul (wordmark `onAccent`) + RouteMotif animado; título `display` + subtítulo; **campo de teléfono** con prefijo fijo **"+51"** y separador, dígitos agrupados 3·3·3, helper debajo. CTA footer "Enviar código".
  - **Paso OTP:** cabecera con **volver** (chevron) + wordmark con tagline; título centrado + subtítulo con teléfono enmascarado ("+51 ··· 321"); **6 casillas OTP** (`OtpField`) con foco animado; texto de expiración; dos filas de acción (reenviar / cambiar número). CTA footer "Verificar".
- **Componentes clave:** campo teléfono custom con prefijo · `OtpField` (6 casillas) · `Banner danger` (error) · `Button accent` · filas `PressableScale` (reenvío + cambiar número) con íconos reloj/lápiz.
- **Estados:**
  - **Teléfono:** CTA **disabled** hasta 9 dígitos válidos; borde `focus` al enfocar, borde `danger` + helper rojo si tocó y es inválido; `loading` mientras solicita; `Banner danger` si falla el request.
  - **OTP:** **shake** de las casillas en cada nuevo error de verificación (`errorNonce`); `Banner danger` si verificación falla; **reenvío bloqueado 30s** con cuenta regresiva `m:ss` (tabular) — fila atenuada (opacity ~0.55) mientras corre; "Cambiar número" vuelve al paso teléfono y limpia el código.
  - OTP expira (timeout 10 min); el copy de expiración lo anticipa.
- **Interacciones & transiciones:** entrada con fade/offset; foco que avanza casilla a casilla; shake en error; chevron back entre pasos.
- **Contenido & copy (sugerido):**
  - Teléfono: título "Tu número" · subtítulo "Te enviamos un código por WhatsApp." · placeholder "987 654 321" · helper "Ingresa tu número de 9 dígitos." · error "Número inválido." · prefijo "+51" · CTA "Enviar código".
  - OTP: título "Ingresa el código" · subtítulo "Enviado al {phone}" · expiración "El código vence en 10 minutos." · "Reenviar" / "Reenviar en {time}" · "Cambiar número" · CTA "Verificar" · error "Código incorrecto."
- **Color & énfasis:** badge de marca y CTA en `accent`; borde de foco `focus` azul; errores `danger`. OTP en dígitos `ink` tabular.
- **Seguridad / nota especial:** flujo de identidad multi-método (verificación server-side por método, ADR-012). Mantener el enmascarado del teléfono. El cooldown de 30s evita abuso de reenvío.
- **Canal de entrega del OTP (ADR-012 §1.2/§6):** **WhatsApp como canal PRINCIPAL** (Meta Cloud API tras el puerto `WhatsAppSender`, excepción §0.7 acotada) con **fallback automático a SMS soberano** (SMPP) si WhatsApp no entrega. El copy lo refleja ("te enviamos un código por WhatsApp"). _⏳ Estado: WhatsApp es el objetivo (ADR-012); hoy el código entrega por SMS — el puerto `WhatsAppSender` está pendiente de construir. No afirmar que WhatsApp ya funciona._

### CompleteProfile (`CompleteProfileScreen.tsx`)
- **Propósito:** completar nombre (obligatorio), correo (opcional) y avatar (opcional, con subida real) tras el primer login.
- **Entrada / Salida:** desde Auth si el perfil no tiene nombre → al guardar, navigator pasa a Main.
- **Layout & jerarquía visual:** scroll. **Arriba:** wordmark + título `display` centrado + subtítulo. **Centro:** **avatar circular con anillo azul punteado** + FAB de cámara azul abajo-derecha. Debajo: formulario (nombre, correo) + fila de nota de privacidad con escudo. CTA footer "Guardar".
- **Componentes clave:** anillo de avatar (dashed `accent`) · FAB cámara · `BottomSheet` selector de origen (Cámara/Galería/Quitar) · `TextField` nombre + correo · `Banner` errores · nota privacidad.
- **Estados:**
  - Avatar: **vacío** (ícono persona) → **preview optimista** al elegir (pop de escala) → **overlay "subiendo"** (scrim `overlay` + spinner) → **éxito** (foto remota) o **error** con texto + **"Reintentar"** (conserva la foto local). Errores específicos: tipo no soportado, muy pesada, permiso denegado.
  - Nombre: validación 2–80 chars; error si tocó e inválido. Correo: opcional pero validado si se escribe.
  - CTA **disabled** hasta nombre válido; `loading` al guardar; `Banner danger` si el guardado falla.
- **Interacciones & transiciones:** pop del avatar al elegir; fade del overlay; sheet de origen desde abajo.
- **Contenido & copy (sugerido):** título "Tu perfil" · subtítulo "Para que el conductor sepa a quién recoge." · "Nombre completo" / "¿Cómo te llamas?" · "Correo (opcional)" · privacidad "Solo el conductor de tu viaje ve tu nombre." · sheet "Agregar foto" / "Tomar foto" / "Elegir de la galería" / "Quitar foto" · CTA "Guardar".
- **Color & énfasis:** anillo de avatar y FAB en `accent`; CTA `accent`; errores `danger`; nota de privacidad en `inkSubtle`.
- **Seguridad / nota especial:** nota de privacidad explícita (transparencia de datos). La subida del avatar es real y reversible.

### BiometricLock (`BiometricLockScreen.tsx`)
- **Propósito:** re-login biométrico (Face ID / huella) en cold-start con sesión persistida, para desbloquear el refresh token.
- **Entrada / Salida:** cold-start con sesión + candado bloqueado → al desbloquear pasa a Main; "Usar otra cuenta" olvida sesión y borra el secreto HMAC de pánico.
- **Layout & jerarquía visual:** **centro** minimalista: título `display color="brand"` + subtítulo + spinner (mientras verifica). Footer: botón "Desbloquear" + "Usar otra cuenta" (ghost).
- **Componentes clave:** `Button` desbloquear · `Button ghost` logout · `ActivityIndicator` azul · `Banner danger` en fallo.
- **Estados:** **checking** (prompt nativo automático al montar + spinner) → **éxito** (desbloquea) / **fallo** (`Banner danger` + botón reintentar). **Sin biometría disponible → desbloquea solo** (degradación segura).
- **Interacciones & transiciones:** prompt biométrico nativo se lanza solo al entrar.
- **Contenido & copy (sugerido):** título "Bienvenido de nuevo" · subtítulo "Desbloquea con tu rostro o huella." · CTA "Desbloquear" · "Usar otra cuenta" · error "No pudimos verificarte. Inténtalo de nuevo."
- **Color & énfasis:** título en `brand` azul; spinner `accent`; error `danger`.
- **Seguridad / nota especial:** **biometría sobre Keychain/Keystore**; degradación segura sin biometría. Logout limpia el secreto HMAC de pánico.

---

# FLUJO 2 · Pedir viaje

Mapa: `Home → Search → RouteQuote → (crea viaje) → TripActive`. Borrador de viaje en `rideDraftStore`.

### Home (`RequestFlowScreen.tsx`)

> Nota de reconciliación (2026-07-03): el Home real es `RequestFlowScreen.tsx` (flujo unificado en un DraggableSheet por fase); `HomeScreen.tsx` quedó legacy sin registrar.
- **Propósito:** punto de partida — mapa oscuro a pantalla completa con tu ubicación y el acceso "¿A dónde vamos?".
- **Entrada / Salida:** tab principal → toca el SearchField → Search; toca un destino reciente → RouteQuote; toca avatar → Profile.
- **Layout & jerarquía visual:** **mapa domina toda la pantalla** (`MapShell` + `AppMap` oscuro con punto de usuario). **Overlay superior:** pill de "Tu ubicación" (etiqueta real por geocoding inverso) a la izquierda + **avatar** de perfil a la derecha. **Overlay inferior:** fila horizontal de **chips de destinos recientes** (máx 3) + **SearchField** "¿A dónde vamos?".
- **Componentes clave:** `MapShell`/`AppMap` · location pill (elevación) · `Avatar` · `RecentChip` (◍ + etiqueta) · `SearchField`.
- **Estados:** **localizando** (mapa con loading, label "Ubicando…") → ubicación real etiquetada. Sin recientes → solo el SearchField. Cada chip se resuelve por geocoding (no muestra el chip hasta tener etiqueta — nada inventado).
- **Interacciones & transiciones:** chips con press-scale y entrada escalonada; SearchField entra con leve delay; mapa interactivo (pan/zoom) pero **no se fija destino tocando el mapa** (el flujo es buscar).
- **Contenido & copy (sugerido):** pill "Tu ubicación" + dirección · SearchField "¿A dónde vamos?" · "Ubicando…".
- **Color & énfasis:** mapa oscuro; pills/chips en `surface` con borde `border`; glifo ◍ del chip en `brand`. Sin CTA azul compitiendo — el azul vive en el SearchField/marca.
- **Seguridad / nota especial:** ninguna directa.

### Search (`SearchScreen.tsx`)
- **Propósito:** buscar y fijar origen y destino con autocompletado, atajos de lugares guardados y "usar mi ubicación".
- **Entrada / Salida:** desde Home (o desde RouteQuote para editar un punto/parada) → al fijar ambos extremos navega a RouteQuote.
- **Layout & jerarquía visual:** **arriba (header fijo):** título "¿A dónde vas?" + cerrar (✕); **`OriginDestinationField`** (origen ◎ + destino ◍, tap para elegir cuál editás); **TextField** de búsqueda con label dinámico (Origen / Destino / Parada N). **Cuerpo:** lista de resultados (`FlatList`) con header de atajos.
- **Componentes clave:** `OriginDestinationField` · `TextField` autofocus · `ListItem` (sugerencias con ◍) · fila "Usar mi ubicación" (◎ azul, solo al editar origen) · `SavedPlacesShortcuts` (Casa/Trabajo/favoritos) · `Banner danger` · `Skeleton`.
- **Estados:** **escribiendo poco** → "Escribe un poco más"; **cargando** → skeletons; **sin resultados** → "Sin resultados"; **error** → `Banner danger`. Lógica de avance: si fija origen y ya hay destino → RouteQuote; si falta el otro extremo, enfoca ese campo.
- **Interacciones & transiciones:** filas entran escalonadas; teclado persiste taps; fijar lugar guardado en un toque.
- **Contenido & copy (sugerido):** título "¿A dónde vas?" · placeholders "Punto de partida" / "¿A dónde vamos?" · campo "Escribe una dirección o lugar" · "Usar mi ubicación" · "Escribe un poco más" · "Sin resultados" · error "No pudimos buscar. Revisa tu conexión."
- **Color & énfasis:** ◎ de origen y "usar mi ubicación" en `brand`; sugerencias neutras; error `danger`.
- **Seguridad / nota especial:** ninguna.

### RouteQuote (`RouteQuoteScreen.tsx`)
- **Propósito:** dibujar la ruta real y cotizar — elegir categoría (Moto/Auto) con precio PEN + ETA, agregar paradas, programar, promo, y confirmar el viaje.
- **Entrada / Salida:** desde Search con origen+destino → al confirmar crea el viaje real; si es inmediato → TripActive; si es programado → ScheduledTrips.
- **Layout & jerarquía visual:** **mitad superior:** mapa con **polyline azul** (ruta real, `fitToRoute`) + botón volver flotante. **Mitad inferior:** **sheet** (esquinas radio `xl` + grabber) que domina la decisión:
  1. **Trayecto editable** (`RoutePointsList`: origen → paradas → destino, + agregar parada, máx 3).
  2. Título "Elige tu viaje" + distancia·duración (tabular).
  3. **Lista de opciones** (`RideOptionRow`): nombre, precio PEN, ETA, descripción (Moto/Auto; la más barata marcada "Más económico"), ícono de vehículo (Moto en `brand`).
  4. **Programar** (pill si ya programado, con "Ahora" para revertir) · **Promo** (`PromoField`) · **CTA confirmar**.
- **Componentes clave:** `AppMap` con ruta · `RoutePointsList` · `RideOptionRow` (con `SelectionBump`) · `VehicleIcon` · `ScheduleSheet` · `PromoField` · `StatusPill brand` (programado) · `Skeleton` · `Banner danger`.
- **Estados:**
  - **Cotizando** → 3 skeletons + "Calculando la mejor tarifa…".
  - **Cotizado** → opciones; **primera (más barata) preseleccionada**.
  - **Error de cotización** → `Banner danger` con acción **Reintentar**.
  - **Cambio de categoría** descarta el promo aplicado (se re-aplica sobre la nueva tarifa).
  - **Programado** → pill azul con fecha/hora + "Ahora".
  - CTA **disabled** hasta tener opción seleccionada; label cambia a "Programar viaje" si hay hora, "Solicitando…" mientras crea. Error de creación → `Banner danger`.
- **Interacciones & transiciones:** selección con "bump"; sheet con scroll interno (máx 64% alto); ScheduleSheet desde abajo.
- **Contenido & copy (sugerido):** "Elige tu viaje" · "Más económico" · "Moto" / "Auto" · "Agregar parada" · "Programar para después" / "Programado para {when}" · "Ahora" · "Código promocional" · CTA "Confirmar viaje" / "Programar viaje" / "Solicitando…" · "Calculando la mejor tarifa…" · "Elige una opción para continuar" · error "No pudimos cotizar. Reintenta."
- **Color & énfasis:** **ruta azul** (`routeColor` + halo `routeGlowColor`) es la estrella del mapa; opción seleccionada con borde/acento; CTA `primary`/`accent`; Moto en `brand`; programado en `brand`.
- **Seguridad / nota especial:** si **Modo niño** está activo, el viaje se crea con `childMode`+código (validado en backend; nunca visible al conductor). El badge de modo niño puede mostrarse acá como confirmación.

---

# FLUJO 3 · Viaje activo

### TripActive (`TripActiveScreen.tsx`) — pantalla más crítica
- **Propósito:** seguimiento en vivo del viaje: conductor, ruta, ubicación, SOS, chat, cámara de cabina, compartir con familia, cancelar/cambiar destino.
- **Entrada / Salida:** desde RouteQuote (viaje inmediato) o desde TripHistory (viaje vivo) → al completar ofrece Payment/Rating; al cancelar queda en estado cancelado.
- **Layout & jerarquía visual:** **mitad superior:** mapa en vivo (`MapShell live`) con ruta, ubicación del conductor y origen/destino. **Flotantes sobre el mapa:** **SosButton** arriba-derecha (rojo, siempre visible en viaje activo) + **botón chat** arriba-izquierda con **badge de no leídos** azul (cuando hay conductor). **Mitad inferior (sheet scrolleable):**
  1. **Fila de estado:** `TripStatusPill` + ETA (tabular).
  2. **Tarjeta del conductor** (`DriverCard`: nombre, rating, vehículo marca·modelo·color, placa, ETA) **o** card "Buscando conductor" con **RoutePin pulsante** (radar) si aún no hay asignación.
  3. **Tarifa** (card).
  4. **Panel de cámara de cabina** (`CabinVideoPanel`) con **indicador "REC"** cuando IN_PROGRESS.
  5. **Acciones:** Cambiar destino · Compartir con la familia · Cancelar (ghost).
- **Componentes clave:** `AppMap` live · `SosButton` · `IconButton` chat + badge · `TripStatusPill` · `DriverCard` · `RoutePin variant="user" pulse` (radar) · `CabinVideoPanel` (StatusPill "REC" danger live) · `Banner` · `BottomSheet` cancelar (con motivo) · `TextField` motivo.
- **Estados (edge cases reales del código):**
  - **Sin conductor asignado** → card **"Buscando conductor"** con radar pulsante (no se inventa conductor). Estados de viaje: `REQUESTED → IN_PROGRESS → COMPLETED` / `CANCELLED`.
  - **Con conductor** → DriverCard real; chat habilitado.
  - **IN_PROGRESS** → panel de cámara activo con **"REC"**.
  - **Cambiar destino**: entra en modo "picking" → `Banner info` "Toca el mapa para elegir el nuevo destino" + Confirmar/Cancelar; mapa pasa a interactivo para fijar punto.
  - **Compartir**: crea enlace firmado y abre hoja nativa; error → `Banner danger`.
  - **Cancelar**: BottomSheet con motivo opcional, botón **danger** "Cancelar viaje" + "Mantener viaje"; error → banner.
  - **COMPLETED** → botones "Pagar ahora" (primary) + "Calificar" (secondary).
  - **CANCELLED** → `Banner warn` y oculta acciones.
  - **Loading / Error** de la pantalla → `LoadingState` / `ErrorState` con reintento.
- **Interacciones & transiciones:** radar pulsa; DriverCard entra con fade; badge de no leídos aparece/desaparece; refetch cada 15s mientras el viaje vive; al abrir chat se marca leído.
- **Contenido & copy (sugerido):** "Buscando conductor" / "Te asignaremos al más cercano…" · "Tu conductor" · "Tarifa" · "REC" / "Grabando" · "Cambiar destino" · "Toca el mapa para elegir tu nuevo destino" · "Compartir con mi familia" · "Cancelar viaje" / "Mantener viaje" · "¿Por qué cancelas?" · "Pagar ahora" · "Calificar" · ETA "{minutes} min".
- **Color & énfasis:** **SOS en `danger`** (único rojo prominente, siempre visible); **"REC" en `danger`**; ruta y badge de chat en `accent`; estado y ETA en `ink`; cancelar en ghost, destructivo en `danger`.
- **Seguridad / nota especial (CRÍTICA):**
  - **Pánico automático SILENCIOSO armado** (`usePanicAutoTrigger`): triple botón de volumen, detección nativa, **sin ningún elemento visible, sin confirmación, sin cambio de layout**. El diseñador NO dibuja UI para esto. Nunca delatar a la víctima.
  - **SOS manual visible** → abre Panic (fullscreen).
  - **"REC" obligatorio** cuando hay cámara: texto + dot + tono danger (consentimiento ya dado en onboarding; el indicador es no negociable).
  - **Compartir con familia** = enlace firmado (HMAC) que caduca al terminar el viaje.

### ScheduledTrips (`ScheduledTripsScreen.tsx`)
- **Propósito:** listar y cancelar viajes programados (estado SCHEDULED) antes de que entren a dispatch.
- **Entrada / Salida:** desde Profile → Preferencias, o tras programar en RouteQuote → cada card permite cancelar.
- **Layout & jerarquía visual:** lista de **tarjetas**; cada una: pill de fecha/hora (`StatusPill brand` + dot), tarifa estimada (tabular), trayecto origen→destino (etiquetas reales por geocoding), conteo de paradas, "Tarifa estimada", botón "Cancelar".
- **Componentes clave:** `Card outlined` · `StatusPill brand` · `Button secondary` cancelar · `BottomSheet` confirmación (danger).
- **Estados:** **loading** (`LoadingState`) · **error** (`ErrorState` + reintento) · **vacío** (`EmptyState`) · lista. Cancelación con confirmación; error → banner.
- **Interacciones & transiciones:** entrada escalonada de cards; sheet de confirmación.
- **Contenido & copy (sugerido):** "Mis viajes programados" · "Programado para {when}" · "{origen} → {destino}" · "1 parada" / "{count} paradas" · "Tarifa estimada" · "Cancelar" · vacío "Sin viajes programados" / "Programa un viaje desde la cotización." · confirmación "¿Cancelar este viaje programado?" / "Sí, cancelar" / "No, mantener".
- **Color & énfasis:** pill de horario en `brand`; tarifa en `ink`; acción destructiva en `danger`.
- **Seguridad / nota especial:** ninguna.

---

# FLUJO 4 · Pago & Rating

### Payment (`PaymentScreen.tsx`)
- **Propósito:** cobrar el viaje (cargo idempotente), elegir método y propina opcional; para efectivo, confirmar el pago.
- **Entrada / Salida:** desde TripActive/TripDetail completado → al pagar muestra éxito y cierra.
- **Layout & jerarquía visual:** **arriba:** card elevada con **monto grande** (`display` tabular, = tarifa + propina). **Centro:** título "¿Cómo pagas?" + card con lista de **métodos** (Cash/Yape/Plin; el por defecto marca pill "Predeterminado"). **Abajo:** campo **Propina** (decimal). Nota de efectivo si aplica. CTA footer "Pagar ahora".
- **Componentes clave:** `Card elevated` monto · `ListItem` por método + `StatusPill accent` default · `TextField` propina · `Banner` (info efectivo / danger error / success éxito) · `SuccessCheck` (animación de tick).
- **Estados:**
  - **Idle** → elegir método + propina.
  - **Pagando** → CTA loading "Pagando…".
  - **Efectivo pendiente** (`cashPending`): tras el cargo, CTA cambia a **"Confirmar efectivo"** (el pasajero confirma que pagó en mano).
  - **Éxito** → pantalla de éxito: `SuccessCheck` + `Banner success` ("Pago realizado" / "Efectivo confirmado") + card con monto. CTA "Cerrar".
  - **Error** → `Banner danger`.
- **Interacciones & transiciones:** tick de éxito animado; banners entran con leve delay.
- **Contenido & copy (sugerido):** "Monto a pagar" · "¿Cómo pagas?" · métodos "Efectivo" / "Yape" / "Plin" · "Predeterminado" · "Propina (opcional)" · efectivo "Págale al conductor al bajar." · CTA "Pagar ahora" / "Pagando…" / "Confirmar efectivo" · éxito "¡Pago realizado!" / "Efectivo confirmado".
- **Color & énfasis:** monto y CTA en `accent`; método default en `accent`; éxito en `success`; error `danger`.
- **Seguridad / nota especial:** propina 100% al conductor; cargo idempotente (no doble cobro).

### Rating (`RatingScreen.tsx`)
- **Propósito:** calificar al conductor (1–5 estrellas) con comentario opcional, y ofrecer propina tras calificar.
- **Entrada / Salida:** desde TripActive/TripDetail completado → al enviar agradece; "Omitir" cierra.
- **Layout & jerarquía visual:** **centro:** subtítulo, **estrellas grandes** (`StarRating`), comentario (multiline, máx 1000). Footer: "Enviar" + "Omitir" (ghost).
- **Componentes clave:** `StarRating` · `TextField` comentario · `Banner` (danger error / success thanks) · `SuccessCheck` · `TipCard` (propina tras calificar).
- **Estados:** **sin estrellas** → al intentar enviar, texto rojo "Elige una calificación"; **enviando** → loading; **éxito** → `SuccessCheck` + `Banner success` + `TipCard` para dejar propina; **error** → banner.
- **Interacciones & transiciones:** estrellas con feedback al tocar; tick de éxito.
- **Contenido & copy (sugerido):** subtítulo "¿Cómo estuvo tu viaje con {driver}?" · "Elige una calificación" · "Cuéntanos más (opcional)" / "Escribe un comentario…" · CTA "Enviar" / "Enviando…" · "Omitir" · "¡Gracias por tu opinión!".
- **Color & énfasis:** estrellas activas en `accent` o `warn` (a criterio, consistente); éxito `success`; error/validación `danger`.
- **Seguridad / nota especial:** ratings < 3.5 levantan flags en backend (no visible al pasajero).

---

# FLUJO 5 · Seguridad / Privacidad

### Panic (`PanicScreen.tsx`)
- **Propósito:** disparo **MANUAL** de pánico (SOS) — envía ubicación + mensaje firmado (HMAC) y muestra el `panicId` de confirmación.
- **Entrada / Salida:** desde el SOS de TripActive (o acceso de soporte) → al enviar muestra confirmación; "Cerrar" vuelve.
- **Layout & jerarquía visual:** **fullscreen, centrado, sobrio y serio.** Título `display` **en `danger`** + subtítulo tranquilizador. Footer: **botón "Enviar alerta" en `danger size="lg"`** + "Cerrar" (ghost).
- **Componentes clave:** `Text display danger` · `Banner` (info nota nativa / danger error / **safe** éxito) · `Card` con `panicId` seleccionable · `Button danger`.
- **Estados:**
  - **Idle** → título + subtítulo + `Banner info` (nota: el disparo automático por triple volumen funciona aunque no toques nada).
  - **Enviando** → CTA loading "Enviando…".
  - **Éxito** → `Banner` **tono safe** "Alerta enviada" + card con **ID de alerta** (`panicId`, copiable) + nota si fue deduplicada.
  - **Error** → `Banner danger`: si falta ubicación, mensaje específico; si no, genérico (nunca envía datos inventados).
- **Interacciones & transiciones:** mínimas — claridad sobre delicia. El éxito en **verde safe** (no rojo) para tranquilizar: "ya estás cubierto".
- **Contenido & copy (sugerido):** título "¿Necesitas ayuda?" · subtítulo "Enviaremos tu ubicación a nuestro equipo de seguridad y a tus contactos de confianza." · `Banner info` "También puedes activar la alerta presionando 3 veces el botón de volumen, sin tocar la pantalla." · CTA "Enviar alerta" / "Enviando…" · éxito "Alerta enviada" / "Estamos contigo. Mantén la calma." · "ID de alerta" · "Cerrar".
- **Color & énfasis:** **`danger` en título y CTA de envío**; **éxito en `safe` (verde)** — la confirmación tranquiliza, no asusta.
- **Seguridad / nota especial (CRÍTICA):** esta es la versión **manual/visible**. La versión **automática es invisible** (triple volumen, nativa, background) y **NO tiene UI** — no la dibujes. Mensaje firmado HMAC; muestra `panicId` para que la víctima sepa que se envió.

### TrustedContacts (`TrustedContactsScreen.tsx`)
- **Propósito:** gestionar hasta **3 contactos de confianza**, cada uno **verificado por OTP**, que reciben tu viaje compartido y tus alertas.
- **Entrada / Salida:** desde Profile → Seguridad → agregar/verificar/reenviar/eliminar.
- **Layout & jerarquía visual:** subtítulo explicativo; **lista de tarjetas** de contacto (nombre, teléfono·relación, **StatusPill** Verificado=success / Pendiente=warn) con acciones por contacto (Verificar, Reenviar, Eliminar). Footer: "Agregar contacto" (disabled al llegar a 3).
- **Componentes clave:** `Card` por contacto + `ListItem` + `StatusPill` · `BottomSheet` alta (nombre, teléfono, relación, correo opc) · `BottomSheet` verificación OTP (6 dígitos) · `BottomSheet` confirmación de borrado (danger) · `Banner`.
- **Estados:** **loading/error/vacío** estándar; **máximo alcanzado** → `Banner info` + CTA disabled. Alta → dispara OTP al contacto y abre verificación. Verificación → CTA disabled hasta 6 dígitos; error → banner. Validación de campos con errores inline (name/phone/relationship/email).
- **Interacciones & transiciones:** sheets desde abajo; pills de estado claras.
- **Contenido & copy (sugerido):** subtítulo "Agrega hasta 3 personas que verán tus viajes y recibirán tus alertas." · "Verificado" / "Pendiente" · "Agregar contacto" · "Enviar código" · "Verificar" · "Reenviar" · "Eliminar" · alta labels "Nombre", "Teléfono", "Relación (ej. mamá, pareja)", "Correo (opcional)" · verificación "Ingresa el código que le enviamos a {phone}" · máximo "Llegaste al máximo de 3 contactos." · borrado "¿Eliminar este contacto?".
- **Color & énfasis:** verificado en `success`, pendiente en `warn`; borrado en `danger`.
- **Seguridad / nota especial:** cada contacto se verifica por OTP propio (no se confía en un número sin validar).

### ChildMode (`ChildModeScreen.tsx`)
- **Propósito:** activar el **Modo niño** con un código de 4–6 dígitos que se exige para cambios de destino (protege a un menor que viaja solo).
- **Entrada / Salida:** desde Profile → Seguridad → al guardar, queda disponible para la próxima solicitud en RouteQuote.
- **Layout & jerarquía visual:** subtítulo; **switch** "Activar modo niño"; **StatusPill** Activo(safe)/Inactivo(neutral); campo **código enmascarado** (numérico, secureTextEntry) solo si está activo; `Banner info` explicativo. Footer "Guardar".
- **Componentes clave:** `Switch` (track azul activo) · `StatusPill` · `TextField` código secreto · `Banner info`.
- **Estados:** **inactivo** → solo switch + pill neutral. **activo** → muestra campo de código; **guardar disabled** hasta código válido (4–6 dígitos); error inline si tocó e inválido. El código se guarda **solo en memoria** (nunca en disco).
- **Interacciones & transiciones:** el campo aparece al activar el switch.
- **Contenido & copy (sugerido):** subtítulo "Protege a quien viaja solo: pediremos un código para cambiar el destino." · "Activar modo niño" · "Activo" / "Inactivo" · "Código (4 a 6 dígitos)" · helper "No lo compartas con el conductor." · error "El código debe tener entre 4 y 6 dígitos." · explicación "El conductor nunca ve este código. Lo validamos de forma segura." · CTA "Guardar".
- **Color & énfasis:** track del switch y activo en `accent`/`safe`; pill activo en `safe`.
- **Seguridad / nota especial (CRÍTICA):** el código **NUNCA se muestra al conductor**; el backend valida un hash. Campo enmascarado, solo en memoria.

### KycCamera (`KycCameraScreen.tsx`)
- **Propósito:** verificación de identidad (KYC) con **liveness activo** — preview de cámara frontal, reto del backend (parpadear/girar), captura de 3 frames, motor ONNX propio.
- **Entrada / Salida:** desde Profile (si no verificado) → resultado aprobado/pendiente/rechazado.
- **Layout & jerarquía visual:** **pantalla de cámara a sangre.** **Zona cámara (domina):** preview frontal espejado, **scrims** arriba/abajo (vignette para legibilidad), **óvalo guía de rostro que "respira"** al centro, **badge "Capturando" (danger, live, dot)** arriba-izquierda, **banner de instrucción del reto** prominente abajo ("Gira la cabeza a la izquierda"). **Panel inferior (`surface`):** título, hint, banners de estado, botones.
- **Componentes clave:** `RTCView` preview · `Animated` óvalo guía (respira) · `StatusPill danger live` "Capturando" · banner de reto sobre `overlay` · `StatusPill` resultado (success/warn/danger) · `Banner` múltiples · `ActivityIndicator` · `Button accent` capturar.
- **Estados:**
  - **Idle** (sin stream) → botón "Iniciar verificación".
  - **Pidiendo reto** → spinner "Preparando…".
  - **Capturando** (stream activo) → óvalo respira, badge "Capturando", instrucción del reto; botón "Capturar".
  - **Enviando** → spinner "Verificando…".
  - **Resultado:** `approved` (success), `pending` (warn), `rejected` (danger, con motivo + botón "Reintentar").
  - **Edge cases reales:** permiso bloqueado → `Banner warn`; error de cámara → `Banner danger`; captura no disponible (sin capa nativa) → `Banner info` y botón capturar disabled; endpoint aún no existe (404) → mensaje "pendiente".
- **Interacciones & transiciones:** **anillo/óvalo que respira** (escala 1→1.035, opacidad 0.65→1, ease-in-out lento) mientras escanea — comunica "te estoy mirando, hacé el gesto". Reduce-motion: óvalo fijo legible. La cámara se libera al salir (privacidad).
- **Contenido & copy (sugerido):** "Verifica tu identidad" · subtítulo "Necesitamos confirmar que eres tú." · hint "Coloca tu rostro dentro del óvalo." / "Sigue la instrucción." · reto "Sigue la instrucción:" + {acción} · "Capturando" · "Iniciar verificación" · "Capturar" · resultados "¡Verificado!" / "En revisión" / "No pudimos verificarte" · "Reintentar".
- **Color & énfasis:** **badge "Capturando" en `danger`** (privacidad visible); óvalo guía en `surface` claro sobre cámara; resultado por tono semántico; CTA captura `accent`.
- **Seguridad / nota especial (CRÍTICA):** **liveness con anillo que respira** (no decorativo: indica escaneo activo) + **indicador visible de captura** (la persona ve que la cámara está prendida). Motor ONNX self-hosted, sin SDK de terceros. La cámara se libera siempre al salir.

---

# FLUJO 6 · Soporte / Comunidad

### Chat (`ChatScreen.tsx`)
- **Propósito:** conversar con el conductor del viaje en vivo (historial REST + entrantes por socket), con plantillas rápidas.
- **Entrada / Salida:** desde TripActive (botón chat) → solo-lectura si el viaje terminó.
- **Layout & jerarquía visual:** **lista de burbujas** (`MessageBubble`): propias en **acento a la derecha**, del conductor en **`surface` a la izquierda**. **Composer abajo:** fila de **chips de plantillas rápidas** + input multiline + botón enviar (↑, tinted azul).
- **Componentes clave:** `FlatList` burbujas · `MessageBubble` · chips quick-reply · `TextField` multiline · `IconButton` enviar · `Banner` (info deshabilitado / danger error).
- **Estados:** **loading/error** estándar; **vacío** → "Aún no hay mensajes" + subtítulo; **enviando** (eco optimista); **viaje terminado** → composer reemplazado por `Banner info` "El chat se cerró"; error de envío → banner. Autoscroll al final con cada mensaje.
- **Interacciones & transiciones:** chips envían con un toque; autoscroll suave; teclado con avoiding view.
- **Contenido & copy (sugerido):** plantillas "Ya salgo", "Estoy en la puerta", "Voy en camino", "Te espero" · placeholder "Escribe un mensaje…" · vacío "Aún no hay mensajes" / "Coordina tu recojo con el conductor." · deshabilitado "El chat se cerró" / "Este viaje ya terminó.".
- **Color & énfasis:** burbuja propia en `accent` (texto `onAccent`); conductor en `surface`; botón enviar tinted azul.
- **Seguridad / nota especial:** ninguna directa.

### Help (`HelpScreen.tsx`)
- **Propósito:** centro de ayuda — FAQ, reportar un problema (ticket) y ver mis solicitudes.
- **Entrada / Salida:** desde Profile → Cuenta → crea tickets / lista tickets.
- **Layout & jerarquía visual:** scroll con 2 bloques: **FAQ** (acordeón `FaqItem` dentro de card) y **Mis solicitudes** (lista de tickets con `StatusPill`). Footer: "Reportar un problema". El reporte vive en un **BottomSheet**: selector de **categoría** (chips), asunto, descripción, opción "adjuntar viaje reciente".
- **Componentes clave:** `FaqItem` acordeón · `Card`/`ListItem` tickets + `StatusPill` (tono por estado) · `BottomSheet` reporte · chips categoría · `TextField` asunto/cuerpo · checkbox adjuntar viaje · `Banner`.
- **Estados:** FAQ siempre presente; tickets **loading/error/vacío** propios; reporte con validación inline (asunto/cuerpo), **éxito** → `Banner success` "Recibimos tu reporte"; error → banner.
- **Interacciones & transiciones:** acordeón expande/colapsa; sheet de reporte; chips de categoría seleccionables.
- **Contenido & copy (sugerido):** "Preguntas frecuentes" · FAQ keys: pedir un viaje, pagos, seguridad, privacidad, cancelaciones · "Mis solicitudes" · vacío "Aún no tienes solicitudes" · "Reportar un problema" · "Categoría" · "Asunto" / "Resume tu problema" · "Descripción" / "Cuéntanos qué pasó" · "Adjuntar viaje reciente" / "Adjuntado" · "Enviar" · éxito "Recibimos tu reporte" / "Te responderemos pronto.".
- **Color & énfasis:** chip de categoría seleccionado en `accent`; estado de ticket por tono; éxito `success`.
- **Seguridad / nota especial:** ninguna directa (los tickets de seguridad escalan en backend).

### Referrals (`ReferralsScreen.tsx`)
- **Propósito:** "Invita y gana" — mostrar tu código (héroe), métricas (referidos / crédito) y canjear el código de un amigo.
- **Entrada / Salida:** desde Profile → Preferencias.
- **Layout & jerarquía visual:** título + subtítulo; **card "héroe"** (`filled`) con tu **código en `display color="accent"`** centrado + Copiar/Compartir; **dos tarjetas de métricas** (referidos · crédito ganado, tabular); sección **Canjear** con input + botón →.
- **Componentes clave:** `Card filled` héroe · `Button secondary` Copiar / `Button accent` Compartir · `Card outlined` métricas · `TextField` canje con `IconButton` tinted · `Banner` · `StatusPill` hint.
- **Estados:** **loading/error** estándar; **copiado** → label cambia a "¡Copiado!" 1.8s; **canje** éxito → `Banner success`; error de código → error inline por razón; error de red → `Banner danger`.
- **Interacciones & transiciones:** feedback inmediato al copiar; share nativo.
- **Contenido & copy (sugerido):** "Invita y gana" · subtítulo "Comparte tu código y ganen los dos." · "Tu código" · "Copiar" / "¡Copiado!" · "Compartir" · "Referidos" · "Crédito ganado" · "Canjear un código" · "Ingresa el código de tu amigo" · éxito "¡Código canjeado!" · error "No pudimos canjear el código.".
- **Color & énfasis:** **único uso fuerte del azul = el código héroe** + CTA Compartir; métricas neutras.
- **Seguridad / nota especial:** ninguna.

---

# FLUJO 7 · Perfil / Preferencias

### Profile (`ProfileScreen.tsx`)
- **Propósito:** hub del usuario — datos, estado KYC, accesos de seguridad/preferencias/cuenta, derecho al olvido y logout.
- **Entrada / Salida:** tab principal → navega a todas las pantallas de seguridad/prefs/soporte.
- **Layout & jerarquía visual:** scroll con secciones:
  1. **Cabecera centrada:** avatar `xl`, nombre, teléfono, **StatusPill de KYC** (success si aprobado, warn si no) + botón "Verificar identidad" si falta.
  2. **Datos:** card con Nombre + Correo (editar).
  3. **Seguridad:** Contactos de confianza · Modo niño · Métodos de pago.
  4. **Preferencias:** Viajes programados · Lugares guardados · Invita y gana.
  5. **Cuenta:** Ayuda · Eliminar mi cuenta · Cerrar sesión.
- **Componentes clave:** `Avatar xl` · `StatusPill` KYC · `Card`/`ListItem chevron` por sección · `BottomSheet` editar (nombre/correo) · `BottomSheet` derecho al olvido (danger) · `BottomSheet` logout (danger).
- **Estados:** **loading/error** estándar; editar con validación inline; **derecho al olvido** → éxito muestra `Banner success` con fecha de gracia; **logout** → confirmación danger, limpia historial, re-arma candado biométrico y borra secreto de pánico.
- **Interacciones & transiciones:** entrada escalonada de secciones; sheets desde abajo.
- **Contenido & copy (sugerido):** "KYC: {estado}" · "Verificar identidad" · "Nombre" / "Sin nombre" · "Correo" / "Sin correo" · secciones "Seguridad" / "Preferencias" / "Cuenta" · "Contactos de confianza" · "Modo niño" · "Métodos de pago" · "Viajes programados" · "Lugares guardados" · "Invita y gana" · "Ayuda" · "Eliminar mi cuenta" · "Cerrar sesión" · olvido "Solicitaremos la eliminación de tus datos. Tienes hasta {date} para revertir." · logout "¿Cerrar sesión?".
- **Color & énfasis:** KYC aprobado en `success`, pendiente en `warn`; "Verificar identidad" en `accent`; acciones destructivas (eliminar cuenta, logout) en `danger`.
- **Seguridad / nota especial:** **derecho al olvido (Ley 29733)** con período de gracia. Logout re-arma el candado biométrico y borra el secreto HMAC de pánico.

### SavedPlaces (`SavedPlacesScreen.tsx`)
- **Propósito:** gestionar lugares guardados (Casa, Trabajo únicos + Favoritos), locales en el dispositivo.
- **Entrada / Salida:** desde Profile → Preferencias; se usan como atajos en Search.
- **Layout & jerarquía visual:** scroll: card con **Casa** (🏠) y **Trabajo** (💼) — fila para agregar si no existen, fila editable si existen (con ✕ eliminar); sección **Favoritos** (★) con lista o vacío; botón "Agregar favorito"; nota "se guardan solo en este equipo". Editor en **BottomSheet** (etiqueta para favoritos + buscador de dirección con autocompletado).
- **Componentes clave:** `Card`/`ListItem` con glifos · `IconButton` ✕ (danger) · `BottomSheet` editor (TextField etiqueta + TextField búsqueda + sugerencias) · `Banner success` (dirección elegida) · `BottomSheet` confirmar borrado.
- **Estados:** Casa/Trabajo presentes o "agregar"; favoritos vacío → card con mensaje; editor: **guardar disabled** hasta elegir punto + etiqueta; búsqueda con loading/sin resultados; borrado con confirmación danger.
- **Interacciones & transiciones:** sheets desde abajo; selección de sugerencia rellena el punto.
- **Contenido & copy (sugerido):** subtítulo "Guarda tus lugares para pedir más rápido." · "Casa" / "Agrega tu casa" · "Trabajo" / "Agrega tu trabajo" · "Favoritos" · vacío "Sin favoritos aún" / "Agrega los lugares que más visitas." · "Agregar favorito" · "Se guardan solo en este equipo." · editor "Nombre del lugar" · "Busca la dirección" · borrado "¿Eliminar este lugar?".
- **Color & énfasis:** favorito ★ en `accent`; ✕ eliminar en `danger`; dirección elegida en `success`.
- **Seguridad / nota especial:** datos **solo locales** (privacidad/soberanía); comunicarlo en copy.

### PaymentMethods (`PaymentMethodsScreen.tsx`)
- **Propósito:** elegir el método de pago **predeterminado** (Cash/Yape/Plin). Preferencia local; el cobro real ocurre en Payment.
- **Entrada / Salida:** desde Profile → Seguridad.
- **Layout & jerarquía visual:** subtítulo + card con lista de métodos; el predeterminado marca **StatusPill "Predeterminado"** (accent + dot).
- **Componentes clave:** `Card outlined` · `ListItem` por método · `StatusPill accent`.
- **Estados:** uno marcado como predeterminado; tocar otro lo cambia. (Sin tarjetas guardadas — fase 4.)
- **Interacciones & transiciones:** entrada escalonada de filas.
- **Contenido & copy (sugerido):** subtítulo "Elige tu método preferido. Lo confirmas al pagar." · métodos "Efectivo" / "Yape" / "Plin" · "Predeterminado".
- **Color & énfasis:** predeterminado en `accent`.
- **Seguridad / nota especial:** ninguna (no se guardan datos sensibles de pago aún).

### TripHistory (`TripHistoryScreen.tsx`)
- **Propósito:** historial de viajes del dispositivo; abre detalle (o re-abre seguimiento si el viaje sigue vivo).
- **Entrada / Salida:** tab principal → fila viva → TripActive; fila terminada → TripDetail.
- **Layout & jerarquía visual:** lista de **tarjetas** (monto tabular como título, fecha + estado como subtítulo, chevron). Footer nota explicativa.
- **Componentes clave:** `Card outlined` + `ListItem chevron` · `EmptyState`.
- **Estados:** **vacío** → `EmptyState`; lista. Refresca al enfocar la pantalla.
- **Interacciones & transiciones:** entrada escalonada; navegación según estado del viaje.
- **Contenido & copy (sugerido):** vacío "Aún no tienes viajes" / "Tu primer viaje aparecerá aquí." · subtítulo de fila "{fecha} · {estado}" · nota "Mostramos los viajes de este equipo.".
- **Color & énfasis:** neutro; estado por texto (no solo color).
- **Seguridad / nota especial:** historial local del dispositivo.

### TripDetail (`TripDetailSheet.tsx`)

> Nota de reconciliación (2026-07-03): el detalle de un viaje terminal ya NO es pantalla — es un sheet sobre "Tus viajes" (`navigation/types.ts` documenta la decisión).
- **Propósito:** detalle de solo-lectura de un viaje pasado: mapa de la ruta, recibo, propina, y pagar/calificar si está completado.
- **Entrada / Salida:** desde TripHistory (viaje terminado) → puede ir a Payment / Rating.
- **Layout & jerarquía visual:** **mapa arriba** (ruta estática, no interactivo) + **sheet** abajo: fila estado + fecha; card tarifa + método; si completado: **recibo** (`TripReceiptCard`, con compartir), **propina** (`TipCard`), botones Pagar/Calificar.
- **Componentes clave:** `AppMap` estático · `TripStatusPill` · `Card` tarifa/método · `TripReceiptCard` · `TipCard` · `Button accent` pagar / `secondary` calificar.
- **Estados:** **loading/error** estándar; **completado** muestra recibo+propina+acciones; otros estados solo estado+tarifa.
- **Interacciones & transiciones:** entrada escalonada de secciones; compartir recibo nativo.
- **Contenido & copy (sugerido):** "Tarifa" · "Método de pago" · "Recibo" · propina "Deja una propina (100% para tu conductor)" · "Pagar ahora" · "Calificar".
- **Color & énfasis:** CTA pagar en `accent`; estado por pill; resto neutro.
- **Seguridad / nota especial:** ninguna directa.

---

## Anexo A · Cobertura de pantallas (23)

| # | Flujo | Pantalla | Archivo |
|---|---|---|---|
| 1 | Onboarding & Auth | Splash | `SplashScreen.tsx` |
| 2 | Onboarding & Auth | Onboarding | `OnboardingScreen.tsx` |
| 3 | Onboarding & Auth | Auth (phone+OTP) | `AuthScreen.tsx` |
| 4 | Onboarding & Auth | CompleteProfile | `CompleteProfileScreen.tsx` |
| 5 | Onboarding & Auth | BiometricLock | `BiometricLockScreen.tsx` |
| 6 | Pedir viaje | Home | `RequestFlowScreen.tsx` |
| 7 | Pedir viaje | Search | `SearchScreen.tsx` |
| 8 | Pedir viaje | RouteQuote | `RouteQuoteScreen.tsx` |
| 9 | Viaje activo | TripActive | `TripActiveScreen.tsx` |
| 10 | Viaje activo | ScheduledTrips | `ScheduledTripsScreen.tsx` |
| 11 | Pago & Rating | Payment | `PaymentScreen.tsx` |
| 12 | Pago & Rating | Rating | `RatingScreen.tsx` |
| 13 | Seguridad | Panic | `PanicScreen.tsx` |
| 14 | Seguridad | TrustedContacts | `TrustedContactsScreen.tsx` |
| 15 | Seguridad | ChildMode | `ChildModeScreen.tsx` |
| 16 | Seguridad | KycCamera | `KycCameraScreen.tsx` |
| 17 | Soporte | Chat | `ChatScreen.tsx` |
| 18 | Soporte | Help | `HelpScreen.tsx` |
| 19 | Soporte | Referrals | `ReferralsScreen.tsx` |
| 20 | Perfil/Prefs | Profile | `ProfileScreen.tsx` |
| 21 | Perfil/Prefs | SavedPlaces | `SavedPlacesScreen.tsx` |
| 22 | Perfil/Prefs | PaymentMethods | `PaymentMethodsScreen.tsx` |
| 23 | Perfil/Prefs | TripHistory + TripDetail | `TripHistoryScreen.tsx` · `TripDetailSheet.tsx` (sheet, no pantalla) |

> Total: **24 pantallas** documentadas (TripHistory y TripDetail comparten fila por pertenecer al mismo flujo de historial). Todas verificadas contra el código real en `veo-passenger-app/src/features/*/presentation/screens/`.
