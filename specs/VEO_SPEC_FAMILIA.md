# VEO — Especificaciones de Diseño · WEB DE FAMILIA

> **Actor:** Familia (madre, pareja, hijo del pasajero).
> **Plataforma:** Web pública, responsive, **mobile-first** — la familia la abre desde el celular, parada en la cocina o en el trabajo, con una sola mano.
> **Sin login. Sin app. Sin cuenta.** Se entra por un **link firmado** que el pasajero comparte. Acceso de **solo lectura**.
> **Tema web:** **azul de marca `#2D7FF9`** en **OKLCH**, soporta **light y dark** (sigue el tema del sistema, sin selector). Ver tokens en `VEO_BRIEF_DISENO.md` §3.3.
> **Lema:** _"Yo veo. Tú vas seguro."_
> **Código de referencia:** `veo-platform/apps/family-web/src`.

---

## 0. El objetivo emocional (leélo antes de diseñar nada)

> **La familia tiene que QUEDARSE TRANQUILA.**

Esto NO es un dashboard. No es un panel de control. No es telemetría. Es **un abrazo a distancia**.

Una madre abre el link porque su hija está volviendo de noche. No quiere "datos del trip": quiere **sentir que su hija está bien**. Cada decisión de diseño se mide contra una sola pregunta:

> _"¿Esto la tranquiliza, o la pone más nerviosa?"_

Reglas que se desprenden, y que mandan sobre cualquier otra:

1. **Cálido, no técnico.** Cero jerga. Nunca "status: IN_PROGRESS", nunca "error 410", nunca "socket desconectado". Siempre lenguaje humano: _"Va en camino"_, _"Tu familiar llegó bien"_.
2. **Tranquilizar es el estado por defecto.** El verde de seguridad y el "todo bien" son la norma. El rojo de alarma **no existe en esta web** — la familia no maneja emergencias, solo acompaña. (El pánico es invisible por diseño; ver §1.)
3. **Nunca un error crudo.** Si algo falla, la familia ve un mensaje calmo que la orienta ("Pídele a tu familiar un link nuevo"), nunca un stack trace ni un código.
4. **Transparencia = confianza.** Cara, nombre, placa, modelo, color del auto, cámara: todo lo que se puede mostrar, se muestra. Lo visible tranquiliza.
5. **Generosidad visual.** Tipografía grande, mucho aire, una cosa importante por vez. La calma se diseña con espacio, no con densidad.

---

## 1. Qué NO se muestra (regla de seguridad — no negociable)

La familia es un actor de **acompañamiento**, no de emergencia. Por eso:

- **No hay botón de pánico, ni alertas rojas, ni "tu familiar está en peligro".** Si el pasajero dispara pánico, la familia **no se entera** — el viaje se ve como una cancelación normal (`ended-cancelled`). Esto protege a la víctima. **PROHIBIDO** cualquier UI que delate un pánico.
- **No se muestra el teléfono del conductor** ni un canal directo de contacto con él. El botón de ayuda llama a un número de ayuda configurado (por defecto **105, PNP**), no al conductor.
- **Solo lectura, siempre.** Nada en esta web cambia el viaje. No se cancela, no se cambia ruta, no se chatea. Se mira y se acompaña.

---

## 2. Sistema base (aplica a todas las vistas)

### 2.1 Tipografía
- **Sans (`Inter`, auto-hospedada)** para todo el texto. **Mono (`JetBrains Mono`)** solo para datos que se leen como dato: **placa** y cifras tabulares (ETA, rating).
- **Generosa y jerárquica.** Títulos grandes (`text-2xl`–`text-4xl`, semibold, tracking ajustado). Cuerpo cómodo (`text-base`/`text-lg`, `leading-relaxed`). El usuario no debe forzar la vista.
- Números con **variante tabular** para que la ETA no "salte" al actualizarse cada segundo.

### 2.2 Espacio y jerarquía
- **Mucho aire.** Una idea dominante por pantalla. En el viaje en vivo: el mapa manda; las tarjetas son apoyo.
- Jerarquía clara: **Estado del viaje → Conductor → Cámara (si hay) → Ayuda**. Siempre en ese orden de importancia.
- Radios suaves del brief (`sm 0.5rem` · `md 0.75rem` · `lg 1rem`). Sombras sutiles (`shadow-1`/`shadow-2`), nunca dramáticas.

### 2.3 Tono de copy — español peruano cálido
- Trato de **"tú"**, cercano y respetuoso. "Tu familiar", "quien quieres", "llegó bien".
- Concreto y humano: _"Llega en unos 8 minutos"_, no _"ETA: 480s"_.
- Tranquilizador en cada estado terminal: _"Gracias por acompañarlo en el camino"_.
- Sin tecnicismos, sin inglés, sin abreviaturas frías.

### 2.4 Accesibilidad (AA, no opcional)
- Contraste **AA** verificado (tokens del brief ya lo garantizan).
- **Nunca comunicar solo por color.** Cada estado lleva **ícono + texto + color**, los tres. El indicador "En vivo" dice "En vivo", no es solo un punto verde.
- Roles ARIA reales: mapa `role="application"` con `aria-label`; indicador en vivo `role="status" aria-live="polite"`; íconos decorativos `aria-hidden`.
- **Respeta `prefers-reduced-motion`**: el latido del indicador y el seguimiento del mapa se desactivan/no animan.

### 2.5 Tema y color
- **Light + dark automáticos** según el sistema (sin parpadeo: se aplica antes de pintar). No hay selector de tema — la familia no debe configurar nada.
- Acento **azul de marca** reservado para lo vivo y lo accionable (ETA, ruta en el mapa, ícono de ayuda, marcador del conductor). **Azul ≤ 10% de la UI.**
- **Verde `--success`** = "todo bien" / "en vivo" / "llegó a destino". Es el color emocional de esta web.
- **Sin rojo de alarma.** El `--danger` del sistema no se usa aquí (ver §1).
- Marca = **azul de marca** (`--brand`, el mismo `--accent`; se distingue por peso y contexto, no por otro color); el wordmark lleva el ícono del ojo (`Eye`) sobre `bg-brand`.

### 2.6 Mobile-first responsive
- **Diseñá para el celular primero.** En móvil todo es **una columna que scrollea**: mapa arriba (~52% del alto de pantalla), panel debajo.
- En pantalla grande (`lg`) se reacomoda a **dos columnas**: mapa a la izquierda ocupando todo el alto, panel a la derecha (máx ~`md`/28rem) con scroll propio. Misma jerarquía, distinto reparto.

---

## 3. Organización por FLUJO

```
(1) Landing / Apertura   →  alguien sin link, o que quiere entender qué es
(2) Validación del token →  se abre el link firmado; el servidor decide qué pantalla toca
(3) Viaje en vivo        →  LA pantalla principal: mapa + estado + conductor + cámara + ayuda
(4) Estados terminales   →  viaje terminó · cancelado · link caducó · link inválido · revocado · sin conexión
```

El servidor clasifica el link en uno de estos estados (`active`, `ended`, `expired`, `invalid`, `revoked`, `unavailable`) y monta directo la pantalla correcta. La familia nunca ve un paso intermedio técnico.

---

## (1) FLUJO — Landing / Apertura

### Landing / Home (ruta `/`)
- **Propósito:** Explicar, a alguien que llega **sin un link de viaje activo**, qué es VEO Family y cómo funciona el link. Es una página tranquila y educativa, no una landing de venta. (Quien sí tiene link va directo al viaje, no pasa por acá.)
- **Entrada / Salida:**
  - *Entrada:* abrir el dominio raíz sin token, o tocar "Ir al inicio" desde un estado terminal o un 404.
  - *Salida:* no hay CTA de conversión. La única "salida" es esperar/pedir un link al familiar. Cierra orientando, no empujando.
- **Layout & jerarquía visual:** Columna única centrada, ancho de lectura cómodo (máx ~3xl), mucho margen vertical. De arriba a abajo:
  1. **Wordmark** "VEO Family" (ícono ojo sobre el azul de marca).
  2. **Titular cálido** grande: el corazón emocional.
  3. **Párrafo** que explica el link en una frase.
  4. **"Cómo funciona el link"** — lista numerada de 3 pasos (números en azul).
  5. **"Qué vas a ver"** — lista con íconos (mapa / reloj / escudo) y descripción.
  6. **Tarjeta "solo lectura"** sobre `surface-2`, que tranquiliza sobre privacidad.
  7. **Footer** discreto.
- **Componentes clave:** Wordmark, lista de pasos numerada, lista descriptiva ícono+texto, tarjeta informativa. **No** hay mapa, ni conductor, ni botón de ayuda acá: todavía no hay viaje.
- **Estados:** Es estática; no tiene estados de carga ni de error propios.
- **Interacciones & transiciones:** Mínimas. Scroll suave. Sin animaciones llamativas — la calma empieza desde el inicio.
- **Contenido & copy (propuesto):**
  - Titular: **"Acompaña el viaje de quien quieres, en vivo."**
  - Intro: _"Cuando un familiar comparte su viaje contigo, recibes un link. Al abrirlo ves dónde está, quién maneja y cuánto falta para llegar. No necesitas instalar ninguna app ni crear una cuenta."_
  - Pasos: _"1. Tu familiar activa el viaje compartido desde la app de VEO y te envía un link por mensaje. 2. Abres el link en tu teléfono; se abre directo el seguimiento, sin pasos extra. 3. Sigues el viaje hasta que llega. El link deja de funcionar cuando el viaje termina."_
  - Qué vas a ver: **"El recorrido en un mapa"** · **"Estado y tiempo de llegada"** · **"Quién maneja"** (nombre, calificación, placa, modelo y color).
  - Tarjeta: _"Tu acceso es solo de lectura. Con el link puedes mirar el viaje, nada más. No puedes cambiar la ruta ni contactar al conductor sin permiso. El link tiene una vigencia corta y caduca solo."_
  - Footer: _"Necesitas un link para ver un viaje. Si no tienes uno, pídelo a tu familiar. · VEO · Movilidad segura."_
- **Color & énfasis:** Azul de marca del wordmark; **azul** solo en los números de los pasos y los íconos de "qué vas a ver". Todo lo demás en tinta neutra. Cero alarma.
- **Nota especial:** Esta página vende **tranquilidad y privacidad**, no la app. Que se sienta que VEO cuida los datos: "solo lectura", "caduca solo", "sin cuenta".

---

## (2) FLUJO — Validación / acceso del token

### Apertura del link de seguimiento (ruta `/t/[token]`)
- **Propósito:** Tomar el link firmado, **validarlo en el servidor** y montar de una la pantalla correcta. La familia abre **un solo link** y aterriza donde corresponde, sin pasos de login ni formularios.
- **Entrada / Salida:**
  - *Entrada:* la familia toca el link recibido por WhatsApp/SMS.
  - *Salida:* el servidor resuelve el token y deriva a **una** de estas pantallas:
    - link válido y viaje en curso → **Viaje en vivo** (§3)
    - viaje ya terminó/canceló → **estado terminal** correspondiente (§4)
    - link incompleto/no existe → **inválido**
    - link vencido → **caducó**
    - el pasajero dejó de compartir → **revocado**
    - no se pudo cargar (red/servidor) → **sin conexión**, con botón de reintento.
- **Layout & jerarquía visual:** No tiene layout propio: es un **enrutador**. Su única UI visible es el **skeleton de carga** (ver más abajo) mientras el servidor resuelve.
- **Componentes clave:** Skeleton de carga (silueta del mapa + silueta de las tarjetas de estado y conductor + silueta del botón). Refleja la forma del viaje en vivo para que la transición se sienta continua.
- **Estados:**
  - **cargando:** skeleton a pantalla completa, con la misma estructura mapa+panel que la vista final.
  - de ahí en adelante, cada resultado del token es una de las pantallas de §3 o §4.
- **Interacciones & transiciones:** El skeleton se reemplaza por el contenido real sin saltos bruscos. La página es siempre **dinámica** (nunca cacheada): son datos en vivo.
- **Contenido & copy:** El skeleton no lleva texto (siluetas grises). Nada de "Cargando token..." ni spinners técnicos.
- **Color & énfasis:** Neutro total. Siluetas en tono `surface`/`surface-2`. Sin acento todavía.
- **Nota especial:** **La validación es invisible para la familia.** No hay pantalla de "verificando acceso", no hay OTP que la familia tenga que escribir (la firma viaja en el link). La seguridad ocurre por detrás; la familia solo siente que "abrió y ya está viendo".

---

## (3) FLUJO — Viaje en vivo (LA pantalla principal)

### Viaje en vivo (ruta `/t/[token]` · estado `active`)
- **Propósito:** El corazón de la web. Que la familia **vea, en tiempo real, que su ser querido está bien y en camino**. Mapa con la ubicación del auto + estado en lenguaje humano + quién maneja + (si está disponible) la cámara del viaje + cómo pedir ayuda.
- **Entrada / Salida:**
  - *Entrada:* token válido con viaje en curso. La vista se **hidrata** con el último estado del servidor y desde ahí escucha actualizaciones **en vivo** (ubicación del conductor, cambios de estado, ETA).
  - *Salida:* cuando el viaje termina/se cancela, la pantalla **transiciona sola** al estado terminal (§4). Si el pasajero deja de compartir, pasa a "revocado". Si se pierde la conexión, degrada con gracia sin sacar a la familia del viaje.

- **Layout & jerarquía visual:**
  - **Móvil (default):** una columna.
    - **Arriba — Mapa grande** (~52% del alto de pantalla). Es el protagonista. Encima, flotando: a la izquierda la píldora **"Vista familiar"**, a la derecha el **indicador EN VIVO**.
    - **Abajo — Panel** que scrollea: `Estado del viaje` → `Conductor` → `Cámara` (si hay) → `Pedir ayuda` → nota de "solo lectura".
  - **Escritorio (`lg`):** dos columnas. Mapa a la izquierda a alto completo; panel a la derecha (máx ~28rem) con scroll propio. Misma jerarquía.

- **Componentes clave:**
  - **Mapa grande (protagonista):** marcador del **conductor** en azul de marca con un halo que **late** (lo vivo), punto de **partida** (relleno azul de marca) y **destino** (anillo azul de marca), y la **ruta** dibujada en azul. Encuadre automático a toda la geometría; luego sigue suavemente al conductor. Controles mínimos (solo zoom).
  - **Tarjeta de Estado (la más importante):** título "Estado del viaje" + **badge** con el estado en palabras + "Viaje de {nombre}" + **ETA** en lenguaje natural con ícono de reloj azul.
  - **Tarjeta del Conductor:** avatar (o ícono persona), **nombre**, **calificación** con estrella, y debajo —separado por línea— **placa** (en mono, destacada), **modelo** y **color**. Oculta limpio cualquier dato que no venga.
  - **Cámara del viaje (opcional):** card con video del habitáculo; solo aparece si el pasajero la autorizó. Etiqueta "En vivo" en verde cuando hay imagen.
  - **Botón "Pedir ayuda":** ancho completo, sobrio, ícono de teléfono en azul. Llama al número de ayuda (105 por defecto). Presente pero **no intrusivo**.
  - **Indicador EN VIVO:** píldora con punto que late (verde "En vivo" / neutro "Reconectando").
  - **Píldora "Vista familiar":** recuerda con calidez que esto es la mirada de la familia.

- **Estados:**
  - **cargando:** skeleton (heredado de §2 validación) hasta que entra la primera vista.
  - **en vivo (conectado):** indicador verde "En vivo" latiendo; mapa y ETA se actualizan solos. ETA visible solo cuando tiene sentido (asignado / en camino / llegando / en viaje).
  - **buscando conductor:** estado "Buscando conductor" (tono neutro); aún puede no haber tarjeta de conductor — se muestra sin inventar datos.
  - **llegó al punto de encuentro:** estado "Llegó al punto de encuentro" (tono "arrived"); momento clave, copy cálido.
  - **viaje terminó / se canceló:** transiciona al estado terminal (§4).
  - **sin conexión (parcial):** indicador cambia a **"Reconectando"** (neutro, sin alarma). El **resto de la vista sigue ahí** con el último dato conocido — la familia no se queda en blanco. Reintenta sola.
  - **mapa no disponible:** si el mapa no carga, en su lugar aparece un bloque calmo: _"Mapa no disponible — El seguimiento del viaje sigue activo. Estamos reconectando el mapa."_ El estado, el conductor y la ETA siguen visibles.
  - **video no disponible (degradación limpia):** la card de cámara nunca muestra un error crudo. Tiene cuatro sub-estados, todos tranquilos: _"Conectando con la cámara"_ · _"La cámara se mostrará cuando esté disponible."_ · imagen en vivo · _"No pudimos mostrar la cámara en este momento."_ Si el pasajero no la activó, **la card no aparece** (sin hueco, sin "no disponible").

- **Interacciones & transiciones:**
  - Actualizaciones en vivo (ubicación/estado/ETA) llegan por socket y se aplican **suavemente**: el marcador del conductor se desliza, la ETA cambia sin parpadear.
  - El mapa hace **paneo suave** siguiendo al conductor — salvo `prefers-reduced-motion`, donde salta sin animar.
  - Transición a estado terminal automática, sin acción de la familia.
  - El botón de ayuda da feedback táctil sutil al presionar (`active:scale`).

- **Contenido & copy (propuesto):**
  - Estados (badge): **"Buscando conductor"**, **"Conductor asignado"**, **"En camino"**, **"Está llegando"**, **"Llegó al punto de encuentro"**, **"En viaje"**, **"Viaje finalizado"**, **"Viaje cancelado"**.
  - Cabecera de estado: **"Viaje de {nombre}"** (p. ej. "Viaje de Camila").
  - ETA en palabras: **"Llega en menos de un minuto"** · **"Llega en un minuto"** · **"Llega en unos 8 minutos"** · **"Llega en una hora"** · **"Calculando tiempo de llegada"**.
  - Cámara: encabezado **"Cámara del viaje"**, etiqueta **"En vivo"**; estados _"Conectando con la cámara"_ / _"La cámara se mostrará cuando esté disponible."_ / _"No pudimos mostrar la cámara en este momento."_
  - Ayuda: botón **"Pedir ayuda"**.
  - Indicador: **"En vivo"** / **"Reconectando"**.
  - Píldora: **"Vista familiar"**.
  - Nota al pie del panel: _"Tu acceso es solo de lectura. El link caduca cuando el viaje termina."_
- **Color & énfasis:**
  - **Azul de marca** = lo vivo y lo accionable: ruta en el mapa, marcador del conductor, ícono del reloj de la ETA, ícono del botón de ayuda.
  - **Verde `--success`** = "En vivo" y "Cámara en vivo": la señal de que **todo está bien**.
  - **Amarillo `--warn`** únicamente en la estrella de calificación del conductor (dato, no alarma).
  - Placa en **mono**, tracking amplio, peso fuerte: se lee como un dato verificable (transparencia).
  - **Sin rojo.** Ni siquiera "Viaje cancelado" usa rojo: tono neutro (ver §1).
- **Nota especial — transparencia y tranquilidad:**
  - El indicador EN VIVO debe ser **sutil pero presente**: la familia tiene que poder confirmar de un vistazo "esto está pasando ahora", sin que la pantalla grite.
  - **Mostrar todo lo que se puede** (cara, nombre, rating, placa, modelo, color) es deliberado: lo visible genera confianza.
  - Ante cualquier degradación (red, mapa, video), la regla es **nunca asustar**: bajar de a poco, con copy que dice "seguimos acá", jamás un error técnico.

---

## (4) FLUJO — Estados terminales

> Todos comparten la misma **plantilla de pantalla de estado**: columna centrada (máx ~md), wordmark arriba, en el centro un **círculo con ícono** + **título** + **párrafo cálido** + (opcional) **acción**. Mobile-first, mucho aire. **Nunca un error crudo, nunca rojo de alarma.** El color emocional del cierre feliz es el **verde**.

### Viaje completado (estado `ended-completed`)
- **Propósito:** Cerrar el acompañamiento con alivio: tu familiar llegó bien.
- **Entrada / Salida:** *Entrada:* el viaje pasó a `COMPLETED` (en vivo o al abrir el link ya terminado). *Salida:* fin del flujo; el link ya no sirve.
- **Layout & jerarquía visual:** Plantilla de estado. Ícono de **check** en círculo.
- **Componentes clave:** Ícono de éxito, título, cuerpo. Sin acción (no hay nada que reintentar — terminó bien).
- **Estados:** Único y final.
- **Interacciones & transiciones:** Si la familia estaba en el viaje en vivo, la pantalla **transiciona sola** a este cierre.
- **Contenido & copy:** Título: **"El viaje terminó"**. Cuerpo: _"Tu familiar llegó a su destino. Gracias por acompañarlo en el camino."_
- **Color & énfasis:** Ícono de check en **verde `--success`** — el "todo bien" final.
- **Nota especial:** Es el momento más importante emocionalmente. Que se sienta **alivio y gratitud**, no un "fin de sesión" frío.

### Viaje cancelado (estado `ended-cancelled`)
- **Propósito:** Informar, con calma, que el viaje no se realizó. **Cubre también el caso de pánico** (que la familia nunca debe poder distinguir de una cancelación común — ver §1).
- **Entrada / Salida:** *Entrada:* viaje en `CANCELLED`. *Salida:* fin; orienta a hablar con el familiar.
- **Layout & jerarquía visual:** Plantilla de estado. Ícono neutro de "cerrado" (X en círculo).
- **Componentes clave:** Ícono neutro, título, cuerpo. Sin botón de reintento.
- **Estados:** Único y final.
- **Interacciones & transiciones:** Transición automática desde el viaje en vivo si llega la cancelación.
- **Contenido & copy:** Título: **"El viaje se canceló"**. Cuerpo: _"Este viaje no se realizó. Si tienes dudas, comunícate con tu familiar."_
- **Color & énfasis:** **Tono neutro, NUNCA rojo.** Ícono en tinta apagada. El copy invita a contactar al familiar, no a alarmarse.
- **Nota especial — crítica:** Esta pantalla **debe verse exactamente igual** ante una cancelación común o ante un pánico. Cualquier diferencia visual delataría a la víctima. Cero pistas, cero urgencia, cero rojo.

### Link caducó (estado `expired`)
- **Propósito:** Explicar, sin frustrar, que el link de seguimiento ya venció.
- **Entrada / Salida:** *Entrada:* `expiresAt` pasó, o el servidor devuelve "vencido" (410). *Salida:* orienta a pedir un link nuevo.
- **Layout & jerarquía visual:** Plantilla de estado. Ícono de **reloj**.
- **Componentes clave:** Ícono, título, cuerpo. Sin acción.
- **Estados:** Único.
- **Contenido & copy:** Título: **"Este link ya caducó"**. Cuerpo: _"Los links de seguimiento duran poco por seguridad. Pídele a tu familiar uno nuevo."_
- **Color & énfasis:** Neutro y suave. Sin alarma. La mención a "por seguridad" refuerza confianza, no miedo.
- **Nota especial:** Que la caducidad se lea como una **virtud de privacidad** ("dura poco por seguridad"), no como un error.

### Link inválido (estado `invalid`)
- **Propósito:** Cubrir links incompletos, mal copiados o inexistentes, sin culpar a la familia.
- **Entrada / Salida:** *Entrada:* token no resuelve (404 / no encontrado). *Salida:* orienta a pedir que se lo compartan de nuevo.
- **Layout & jerarquía visual:** Plantilla de estado. Ícono de **link roto**.
- **Componentes clave:** Ícono, título, cuerpo. Sin acción.
- **Estados:** Único.
- **Contenido & copy:** Título: **"Este link no es válido"**. Cuerpo: _"Puede que el enlace esté incompleto. Pídele a tu familiar que te lo comparta de nuevo."_
- **Color & énfasis:** Neutro. Sin tono de regaño ni de error técnico.
- **Nota especial:** Asumir buena fe: "puede que esté incompleto", nunca "link erróneo".

### Dejó de compartirse / revocado (estado `revoked`)
- **Propósito:** Explicar que el pasajero **desactivó** el seguimiento (no es un fallo).
- **Entrada / Salida:** *Entrada:* el viaje fue revocado (en vivo llega el evento, o 403 al abrir). *Salida:* orienta a pedir que lo compartan otra vez.
- **Layout & jerarquía visual:** Plantilla de estado. Ícono de **ojo tachado**.
- **Componentes clave:** Ícono, título, cuerpo. Sin acción.
- **Estados:** Único; puede llegar **en vivo** (corta el seguimiento de inmediato).
- **Contenido & copy:** Título: **"El viaje dejó de compartirse"**. Cuerpo: _"Tu familiar desactivó el seguimiento. Si lo necesitas, pídele que lo comparta otra vez."_
- **Color & énfasis:** Neutro. Enmarca el control como algo **del pasajero** (su privacidad), no como un problema.
- **Nota especial:** Refuerza la **soberanía del pasajero** sobre sus datos: él decide quién ve y hasta cuándo.

### Sin conexión / no se pudo cargar (estado `unavailable` · y frontera de error)
- **Propósito:** Cuando no se pudo cargar el viaje (red de la familia o servidor), ofrecer calma y un **camino claro: reintentar**. Es el único estado terminal con acción.
- **Entrada / Salida:** *Entrada:* fallo de red/servidor al resolver el token, o un error inesperado capturado por la frontera de error. *Salida:* botón que **reintenta** y, si todo está bien, recupera el viaje en vivo.
- **Layout & jerarquía visual:** Plantilla de estado. Ícono de **wifi tachado** + **botón de acción** debajo.
- **Componentes clave:** Ícono, título, cuerpo, **botón "Intentar de nuevo"** (secundario, con ícono de recarga).
- **Estados:** Estable con reintento. Distinto del "Reconectando" *dentro* del viaje en vivo (§3), que no saca a la familia de la pantalla; este aplica cuando **aún no se pudo entrar**.
- **Interacciones & transiciones:** El botón reintenta la carga; éxito → viaje en vivo; nuevo fallo → se mantiene este estado, calmo, sin acumular errores.
- **Contenido & copy:** Título: **"No pudimos cargar el viaje"**. Cuerpo: _"Revisa tu conexión a internet e intenta de nuevo en un momento."_ Botón: **"Intentar de nuevo"**.
- **Color & énfasis:** Neutro. El acento (azul de marca) vive en el botón de acción. Cero rojo, cero "error".
- **Nota especial:** Diferenciar **"no pude entrar"** (este, con reintento) de **"estoy adentro pero perdí señal un momento"** (§3, degradación parcial que conserva el último dato). En ningún caso un código de error.

### Página no encontrada (ruta desconocida · `404`)
- **Propósito:** Ruta que no existe; reorientar a abrir el link compartido.
- **Entrada / Salida:** *Entrada:* URL inexistente. *Salida:* botón **"Ir al inicio"** → Landing (§1).
- **Layout & jerarquía visual:** Variante de la plantilla de estado, centrada, con wordmark.
- **Componentes clave:** Wordmark, título, cuerpo, **botón azul "Ir al inicio"**.
- **Estados:** Único.
- **Contenido & copy:** Título: **"No encontramos esta página"**. Cuerpo: _"Para ver un viaje necesitas el link que te compartió tu familiar. Si lo tienes, ábrelo de nuevo."_ Botón: **"Ir al inicio"**.
- **Color & énfasis:** Botón en **azul de marca** (única acción primaria). Resto neutro.
- **Nota especial:** Siempre devolver a un lugar útil; nunca dejar a la familia en un callejón sin salida.

---

## 5. Resumen de jerarquía de color (referencia rápida)

| Señal | Token (brief §3.3) | Dónde |
|---|---|---|
| Lo vivo / accionable | **`--accent`** (azul de marca) | ruta del mapa, marcador conductor, reloj ETA, ícono ayuda, botón 404/reintento |
| "Todo bien" / en vivo | **`--success`** (verde) | indicador "En vivo", "Cámara en vivo", check de "viaje terminó" |
| Dato/calificación | `--warn` (amarillo) | solo la estrella de rating |
| Marca | `--brand` (azul de marca) | wordmark, punto de partida/destino en el mapa |
| Texto / fondos | `--ink` / `--bg` / `--surface` / `--surface-2` | todo el cuerpo, tarjetas, skeletons |
| **Rojo de alarma** | `--danger` | **NO se usa en esta web** (ver §1) |

**Bandera peruana** (`#D91023`) solo si aparece el wordmark completo de VEO; es la única excepción de color "crudo".

---

_Fuente del comportamiento real: `veo-platform/apps/family-web/src` — `app/page.tsx`, `app/t/[token]/page.tsx`, `app/t/[token]/loading.tsx`, `app/error.tsx`, `app/not-found.tsx`, `components/tracking/*` (`tracking-view`, `live-tracking`, `trip-map`, `status-card`, `driver-card`, `cabin-video`, `state-screen`, `help-button`), `components/ui/live-indicator`, `lib/format.ts`, `lib/share-state.ts`. Tokens y principios: `VEO_BRIEF_DISENO.md` §3.3, §6, §9._
