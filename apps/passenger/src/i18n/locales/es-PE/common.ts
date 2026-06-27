/**
 * Recursos base (namespace `common`) en es-PE. Lima/Perú es el idioma por defecto
 * (regla del repo); es-ES / en-US se añaden después manteniendo es-PE como fallback.
 *
 * Se agrupa por feature para que las pantallas referencien claves estables y tipadas
 * (`t('auth.phoneTitle')`). NO hay textos hardcodeados en la UI: todo cuelga de aquí.
 */
export const common = {
  appName: 'VEO',
  tagline: 'Tu viaje, vigilado y seguro',
  /** Tagline del splash (pantalla de arranque). */
  splashTagline: 'Movilidad segura',
  /** Taglines de marca usadas en cabeceras del flujo de ingreso. */
  brandTaglineCity: 'Tu viaje. Tu ciudad.',
  brandTaglinePeru: 'Tu viaje en Perú',
  placeholder: {
    subtitle: 'Pantalla en construcción',
  },

  /** Acciones reutilizables. */
  actions: {
    continue: 'Continuar',
    cancel: 'Cancelar',
    confirm: 'Confirmar',
    retry: 'Reintentar',
    save: 'Guardar',
    back: 'Volver',
    close: 'Cerrar',
    delete: 'Eliminar',
    add: 'Agregar',
    send: 'Enviar',
    resend: 'Reenviar',
    verify: 'Verificar',
    edit: 'Editar',
    logout: 'Cerrar sesión',
    accept: 'Aceptar',
    change: 'Cambiar',
    skip: 'Omitir',
  },

  /** Estados genéricos de carga / error / vacío. */
  states: {
    loading: 'Cargando…',
    errorTitle: 'Algo salió mal',
    errorBody: 'No pudimos completar la operación. Inténtalo de nuevo.',
    empty: 'Sin información',
  },

  screens: {
    splash: 'Inicio',
    onboarding: 'Bienvenida',
    auth: 'Ingresar',
    home: 'Pedir viaje',
    offersBoard: 'Ofertas',
    counter: 'Contraoferta',
    noOffers: 'Sin ofertas',
    tripActive: 'Viaje en curso',
    cameraControl: 'Control de cámara',
    panic: 'Emergencia',
    trustedContacts: 'Contactos de confianza',
    childMode: 'Modo niño',
    kycCamera: 'Verificación de identidad',
    paymentMethods: 'Métodos de pago',
    payment: 'Pago del viaje',
    rating: 'Califica tu viaje',
    tripHistory: 'Mis viajes',
    scheduledTrips: 'Mis viajes programados',
    scheduleNew: 'Programar viaje',
    notifications: 'Notificaciones',
    lostItem: 'Olvidé algo',
    profile: 'Perfil',
    savedPlaces: 'Lugares guardados',
    referrals: 'Invita y gana',
    chat: 'Chat con tu conductor',
    help: 'Centro de ayuda',
    completeProfile: 'Completa tu perfil',
  },

  /**
   * Onboarding interactivo (3 slides): seguridad, precio/elige tu VEO y consentimientos
   * (Ley N.° 29733). Los 3 consentimientos siguen bloqueando "Aceptar y continuar".
   */
  onboarding: {
    skip: 'Saltar',
    next: 'Siguiente',
    /** Indicador "n / total" (esquina del slide de precio). */
    step: '{{current}} / {{total}}',

    safety: {
      eyebrow: 'Seguridad',
      title: 'Nunca viajas solo',
      body: 'Conductor verificado y pánico 24/7, en cada viaje.',
      imageAlt: 'Pasajera viajando tranquila de noche',
    },

    price: {
      title: 'Tu auto, en minutos',
      body: 'Autos cómodos y verificados, cuando los necesitas.',
      car: 'VEO Auto',
      carTagline: 'Cómodo, seguro y siempre verificado',
    },

    consent: {
      title: 'Tus datos, protegidos',
      subtitle: 'Solo lo necesario para cuidarte.',
      sectionLabel: 'Consentimientos',
      data: 'Tratamiento de mis datos personales',
      camera: 'Uso de la cámara para verificación',
      location: 'Acceso a mi ubicación durante el viaje',
      legal: 'Ley N.° 29733 · Política de privacidad',
      accept: 'Aceptar y continuar',
    },
  },

  auth: {
    /** Paso inicial: elegir método de ingreso. */
    startTitle: 'Bienvenido a VEO',
    startSubtitle: 'Elige cómo quieres entrar.',
    continueGoogle: 'Continuar con Google',
    continueApple: 'Continuar con Apple',
    continueEmail: 'Continuar con correo',
    continuePhone: 'Continuar con teléfono',
    startHint: '¿Sin señal para el SMS? Entra con correo o Google.',
    /** Errores del login social (Google/Apple). Cancelar NO muestra Banner. */
    oauthErrorTitle: 'No pudimos iniciar sesión',
    oauthErrorUnavailable:
      'El inicio de sesión no está disponible en este dispositivo. Prueba con correo o teléfono.',
    oauthErrorInvalidAccount:
      'No pudimos validar tu cuenta. Inténtalo de nuevo o entra con correo o teléfono.',
    oauthErrorNetwork: 'Sin conexión. Revisa tu internet e inténtalo de nuevo.',
    oauthErrorUnknown: 'Algo salió mal. Inténtalo de nuevo en un momento.',
    /** Aviso de degradación honesta para métodos sin backend. */
    comingSoonTitle: 'Próximamente',
    comingSoonGoogle:
      'El ingreso con Google estará disponible pronto. Por ahora, entra con tu teléfono.',
    comingSoonEmail:
      'El ingreso con correo estará disponible pronto. Por ahora, entra con tu teléfono.',
    comingSoonCall: 'Recibir el código por llamada estará disponible pronto.',
    comingSoonWhatsapp:
      'El envío del código por WhatsApp estará disponible pronto.',
    back: 'Volver',
    phoneTitle: 'Ingresa tu número',
    phoneSubtitle: 'Te enviamos un código por SMS.',
    phoneLabel: 'Número de teléfono',
    phoneHelper: 'Usaremos tu número solo para verificar tu cuenta.',
    phonePlaceholder: '987 654 321',
    countryCode: '+51',
    invalidPhone: 'Ingresa un número peruano válido (9 dígitos).',
    requestOtp: 'Enviar código',
    otpTitle: 'Verifica tu número',
    otpSubtitle: 'Ingresa el código que enviamos al {{phone}}',
    otpLabel: 'Código de verificación',
    otpProgress: '{{current}} de {{length}}',
    invalidOtp: 'El código debe tener 6 dígitos.',
    otpExpiry: 'El código expirará en 5 minutos.',
    verify: 'Verificar',
    resend: 'Reenviar código',
    resendIn: 'Reenviar en {{time}}',
    /** Teclado numérico propio del paso OTP. */
    otpKeypadLabel: 'Teclado numérico',
    otpKeyLabel: 'Marcar {{digit}}',
    /** Ayuda "¿No te llegó el código?" → bottom-sheet. */
    otpHelpTrigger: '¿No te llegó el código?',
    otpHelpTitle: '¿No te llegó el SMS?',
    otpHelpSubtitle: 'A veces el SMS se demora. Prueba otra vía:',
    otpHelpCall: 'Recibir el código por llamada',
    otpHelpWhatsapp: 'Enviar por WhatsApp',
    otpHelpEmail: 'Mejor entro con correo',
    otpHelpResend: 'Reenviar SMS',
    errorRequest:
      'No pudimos enviar el código. Verifica tu número e inténtalo de nuevo.',
    errorRequestHint: 'Revisa tu conexión e inténtalo de nuevo.',
    errorVerify: 'Código incorrecto o vencido. Inténtalo de nuevo.',
    changeNumber: 'Cambiar número',
    /** Pantalla de sesión expirada (refresh JWT vencido/revocado). */
    expiredTitle: 'Tu sesión expiró',
    expiredSubtitle:
      'Por tu seguridad cerramos la sesión. Vuelve a iniciar sesión para verificar tu identidad y continuar.',
    expiredAction: 'Volver a iniciar sesión',
    biometricTitle: 'Desbloquea VEO',
    biometricSubtitle:
      'Usa tu rostro o huella para continuar tu sesión de forma segura.',
    biometricUnlock: 'Desbloquear',
    biometricReason: 'Verifica tu identidad para continuar tu sesión',
    biometricError: 'No pudimos verificar tu identidad. Inténtalo de nuevo.',
    biometricLogout: 'Usar otra cuenta',

    /* ── Ingreso por correo + contraseña (ADR-012) ── */
    email: {
      /** Cabecera del flujo de correo. */
      title: 'Entra con tu correo',
      subtitle: 'Usa tu correo y contraseña para acceder a VEO.',
      /** Toggle iniciar sesión / crear cuenta. */
      tabLogin: 'Iniciar sesión',
      tabRegister: 'Crear cuenta',
      tabsLabel: 'Elige iniciar sesión o crear una cuenta',
      /** Campos. */
      emailLabel: 'Correo',
      emailPlaceholder: 'tucorreo@ejemplo.com',
      passwordLabel: 'Contraseña',
      passwordPlaceholder: 'Tu contraseña',
      newPasswordPlaceholder: 'Nueva contraseña',
      nameLabel: 'Nombre (opcional)',
      namePlaceholder: 'Ej.: María Fernanda',
      showPassword: 'Mostrar contraseña',
      hidePassword: 'Ocultar contraseña',
      /** Ayudas / validación de campos. */
      invalidEmail: 'Ingresa un correo válido.',
      passwordHint: 'Mínimo 12 caracteres.',
      invalidPassword: 'La contraseña debe tener al menos 12 caracteres.',
      /** CTAs. */
      loginCta: 'Iniciar sesión',
      registerCta: 'Crear cuenta',
      forgotCta: '¿Olvidaste tu contraseña?',
      /** Verificación del correo (reusa OtpField/OtpKeypad). */
      verifyTitle: 'Verifica tu correo',
      verifySubtitle: 'Ingresa el código de 6 dígitos que enviamos a {{email}}',
      verifyCta: 'Verificar',
      /** Olvidé mi contraseña → enviar código. */
      forgotTitle: '¿Olvidaste tu contraseña?',
      forgotSubtitle:
        'Ingresa tu correo y te enviaremos un código para restablecerla.',
      forgotSendCta: 'Enviar código',
      forgotSent:
        'Si ese correo está registrado, te enviamos un código. Revisa tu bandeja y el spam.',
      /** Restablecer contraseña → código + nueva contraseña. */
      resetTitle: 'Crea una nueva contraseña',
      resetSubtitle:
        'Ingresa el código que enviamos a {{email}} y tu nueva contraseña.',
      resetCodeLabel: 'Código de verificación',
      resetCta: 'Guardar contraseña',
      resetDone: 'Tu contraseña se actualizó. Inicia sesión con la nueva.',
      /** Reenvío del código de verificación. */
      resend: 'Reenviar código',
      resendIn: 'Reenviar en {{time}}',
      codeExpiry: 'El código expirará pronto. Si no llega, reenvíalo.',
      /** Errores (Banner danger) por caso (caminos infelices). */
      errorInvalidCredentials: 'Correo o contraseña incorrectos.',
      errorNotVerified:
        'Verifica tu correo para continuar. Te reenviamos el código.',
      errorAlreadyExists: 'Ese correo ya está registrado. Inicia sesión.',
      errorWeakPassword:
        'Esa contraseña no es válida. Usa al menos 12 caracteres y algo no obvio.',
      errorInvalidCode: 'Código incorrecto o vencido. Inténtalo de nuevo.',
      errorNetwork: 'Sin conexión. Revisa tu internet e inténtalo de nuevo.',
      errorUnknown: 'Algo salió mal. Inténtalo de nuevo.',
    },
  },

  /** Completar perfil tras verificar el OTP (usuario nuevo / sin perfil). */
  profileSetup: {
    title: 'Cuéntanos quién eres',
    subtitle:
      'Tu nombre es lo único que necesitamos: tu conductor sabrá a quién recoger.',
    photoAction: 'Agregar foto de perfil',
    photoSheetTitle: 'Foto de perfil',
    photoFromCamera: 'Tomar foto',
    photoFromLibrary: 'Elegir de la galería',
    photoRemove: 'Quitar foto',
    photoPermission:
      'Necesitamos tu permiso para usar la cámara o tus fotos. Actívalo en Ajustes.',
    photoError: 'No pudimos abrir el selector de fotos. Inténtalo de nuevo.',
    photoUploading: 'Subiendo tu foto…',
    photoUploadError: 'No pudimos subir tu foto. Inténtalo de nuevo.',
    photoUnsupported: 'Ese formato no va. Usa una imagen JPG, PNG o WebP.',
    photoTooLarge:
      'Esa imagen pesa demasiado (máx. 5 MB). Elige una más liviana.',
    photoUploadRetry: 'Reintentar',
    nameLabel: 'Nombre completo',
    namePlaceholder: 'Ej.: María Fernanda Ríos',
    emailLabel: 'Correo (opcional)',
    emailPlaceholder: 'tucorreo@ejemplo.com',
    /** "Porqué en una línea" del campo opcional (pedido del dueño): qué gana el usuario si lo carga. */
    emailNote: 'Para enviarte tus recibos y avisos importantes.',
    /** Microcopy de la fila de correo de solo lectura: el correo ya vino de la cuenta (Apple/Google).
     *  Genérico elegante a propósito: la data del perfil no expone el proveedor. */
    emailFromAccount: 'Lo tomamos de tu cuenta',
    privacyNote:
      'Tus datos están protegidos y solo los usamos para que viajes mejor.',
    submit: 'Empezar a viajar',
    invalidName:
      'Necesitamos tu nombre para que tu conductor sepa a quién recoger (2 a 80 caracteres).',
    invalidEmail: 'Revisa tu correo, parece que le falta algo.',
    saveError: 'No pudimos guardar tu perfil. Inténtalo de nuevo.',
  },

  home: {
    title: '¿A dónde vamos?',
    greeting: 'Hola',
    whereTo: '¿A dónde vamos?',
    /** Título héroe editorial del Home idle (ancla visual grande, arriba con aire). */
    heroTitle: '¿A dónde vamos?',
    yourLocation: 'Tu ubicación',
    pickupLabel: 'Recojo',
    /** Placeholder de la fila de origen cuando aún no hay ubicación resuelta (GPS sin fix). */
    definePickup: 'Define tu punto de recojo',
    adjustPickup: 'Ajustar',
    /** Botón circular que permuta origen ↔ destino en la tarjeta de ruta del Home. */
    swapRoute: 'Intercambiar origen y destino',
    /** Tarjeta del último conductor con quien viajaste (atajo de confianza). */
    lastDriverTitle: 'Tu último conductor',
    /** Título de la sección teaser del catálogo de servicios (informativa, sin precio, en el Home idle). */
    servicesTitle: 'Nuestros servicios',
    shortcutHome: 'Casa',
    shortcutWork: 'Trabajo',
    shortcutRecent: 'Recientes',
    /** Título de la sección "Tus últimos viajes" del Home idle (últimos 3 viajes reales). */
    recentTripsTitle: 'Tus últimos viajes',
    /** Etiqueta accesible de una fila de últimos viajes: destino + metadatos (día · distancia · duración). */
    recentTripRowLabel: 'Pedir de nuevo a {{destination}}. {{meta}}',
    /** Título de la sección de favoritos guardados en el cuerpo del sheet. */
    savedTitle: 'Guardados',
    /** Enlace "ver todas" → pantallas de gestión (lugares guardados / historial). */
    seeAll: 'Ver todas',
    origin: 'Origen',
    destination: 'Destino',
    setOrigin: 'Fijar origen',
    setDestination: 'Fijar destino',
    tapToSetOrigin: 'Toca el mapa para fijar tu punto de partida.',
    tapToSetDestination: 'Toca el mapa para fijar tu destino.',
    selectedOnMap: 'Punto en el mapa',
    locating: 'Ubicándote…',
    locationUnavailable: 'No pudimos ubicarte',
    /** Permiso de ubicación negado: derivar a Ajustes de la app. */
    locationDenied: 'Permite la ubicación',
    /** Permiso ok pero GPS del dispositivo apagado: derivar a Ajustes de ubicación. */
    locationServicesOff: 'Activa el GPS',
    /** CTA del pill cuando hay que ir a Ajustes del sistema. */
    locationActionSettings: 'Ajustes',
    /** CTA del pill para reintentar el fix. */
    locationActionRetry: 'Reintentar',
    /** Botón flotante del mapa para volver la cámara a mi ubicación tras panear libremente. */
    recenter: 'Centrar en mi ubicación',
    /** Campana de avisos de la Home (centro de notificaciones sin backend todavía). */
    notifications: 'Avisos',
    notificationsComingSoon:
      'El centro de avisos llega en una próxima versión. Te avisaremos por notificación cuando tu conductor esté en camino.',
    quote: 'Cotizar viaje',
    quoting: 'Cotizando…',
    fare: 'Tarifa',
    distance: 'Distancia',
    duration: 'Duración',
    surgeActive: 'Demanda alta (x{{multiplier}})',
    paymentMethod: 'Método de pago',
    childMode: 'Modo niño',
    childModeOn: 'Activado',
    childModeOff: 'Desactivado',
    confirmTrip: 'Confirmar viaje',
    requesting: 'Solicitando…',
    needDestination: 'Fija un destino para cotizar.',
    quoteError: 'No pudimos cotizar el viaje. Inténtalo de nuevo.',
    outsideLima: 'Por ahora operamos solo en Lima Metropolitana.',
  },

  /**
   * Centro de avisos (campana del Home). Sin endpoint de listado en el bff todavía: el repositorio
   * devuelve un feed vacío honesto y la pantalla aterriza en el estado vacío con un aviso claro.
   */
  notifications: {
    // Pre-prompt contextual de permiso de push (al buscar conductor). Tuteo peruano.
    prePromptTitle: 'Activa las notificaciones',
    prePromptBody:
      'Te avisamos cuando un conductor acepte tu viaje y cuando esté llegando, aunque tengas la app cerrada.',
    prePromptEnable: 'Activar notificaciones',
    prePromptDismiss: 'Ahora no',
    empty: 'No tienes avisos',
    emptySubtitle: 'Cuando tengas novedades de tus viajes, las verás aquí.',
    end: 'No hay más notificaciones.',
    loadError: 'No pudimos cargar tus avisos. Inténtalo de nuevo.',
  },

  /**
   * Reasignación (estado REASSIGNING): el conductor canceló antes del recojo. El board de ofertas se
   * reabre en el servidor al mismo precio y sin cargo; esta pantalla lo comunica y lleva al board.
   */
  reassign: {
    title: 'Tu conductor canceló',
    body: 'No te preocupes: estamos buscando otro conductor al mismo precio ({{price}}). Sin cargo para ti.',
    bodyNoPrice:
      'No te preocupes: estamos buscando otro conductor al mismo precio. Sin cargo para ti.',
    note: 'Tu viaje vuelve al tablero de ofertas. Elige al nuevo conductor que mejor te convenga.',
    continue: 'Ver conductores disponibles',
    cancel: 'Cancelar y volver al inicio',
  },

  /**
   * Programar un viaje nuevo (botón "+" de "Mis viajes programados"). Entrada al flujo REAL de
   * programación (destino → día/hora → confirmar con tarifa estimada y POST /trips con scheduledFor).
   */
  scheduleNew: {
    entry: 'Programar nuevo viaje',
    cta: 'Elegir destino',
    intro:
      'Programa un viaje para después. Te buscaremos conductor a tiempo y confirmaremos la tarifa al activarse.',
    step1Title: 'Elige tu destino',
    step1Body:
      'Busca a dónde quieres ir; tu origen se toma de tu ubicación actual.',
    step2Title: 'Revisa tu trayecto',
    step2Body: 'Verás la ruta y la tarifa estimada antes de confirmar.',
    step3Title: 'Elige día y hora',
    step3Body:
      'Programa con al menos 15 minutos de anticipación y hasta 7 días en adelante.',
    note: 'Te buscaremos conductor unos minutos antes. La tarifa se confirma al activarse el viaje.',
  },

  /**
   * "Olvidé algo" (desde el detalle de un viaje). No hay endpoint dedicado: el reporte se crea como un
   * ticket de soporte (categoría DRIVER) con el viaje adjunto; VEO media el contacto con el conductor.
   */
  lostItem: {
    entry: 'Olvidé algo',
    intro:
      'Cuéntanos qué olvidaste en el viaje. VEO avisa al conductor y media el contacto por ti.',
    whatLabel: '¿Qué olvidaste?',
    items: {
      phone: 'Celular',
      wallet: 'Billetera',
      backpack: 'Mochila',
      keys: 'Llaves',
      other: 'Otro',
    },
    subject: 'Objeto olvidado: {{item}}',
    descriptionLabel: 'Descríbelo',
    descriptionPlaceholder:
      'Color, dónde estaba, cualquier detalle que ayude a encontrarlo…',
    invalidDescription:
      'Cuéntanos un poco más (al menos 10 caracteres) para ayudar a encontrarlo.',
    privacyNote:
      'Por seguridad, tu número se mantiene oculto. VEO media el contacto con el conductor.',
    mediationNote:
      'Nuestro equipo gestiona el reporte y te responde por la app.',
    submit: 'Avisar al conductor',
    sentTitle: 'Reporte enviado',
    sentBody:
      'Avisamos a tu conductor sobre tu objeto. Te responderemos por la app con las novedades.',
    error: 'No pudimos enviar tu reporte. Inténtalo de nuevo.',
  },

  /** Búsqueda inteligente de direcciones (origen/destino). */
  maps: {
    searchTitle: '¿A dónde vamos?',
    originPlaceholder: 'Punto de recogida',
    destinationPlaceholder: '¿A dónde vamos?',
    inputPlaceholder: 'Busca una dirección o lugar',
    currentLocation: 'Tu ubicación actual',
    useCurrentLocation: 'Usar mi ubicación actual',
    noResults: 'Sin resultados para tu búsqueda.',
    typeMore: 'Escribe al menos 3 caracteres para buscar.',
    searchError: 'No pudimos buscar direcciones. Inténtalo de nuevo.',
    pickOnMap: 'Elegir en el mapa',
    pickedPoint: 'Ubicación elegida en el mapa',
    pickup: {
      titleOrigin: 'Ajusta tu punto de recojo',
      titleDestination: 'Ajusta tu destino',
      titleStop: 'Ajusta la parada {{index}}',
      hint: 'Mueve el mapa para ubicar el punto exacto',
      resolving: 'Buscando dirección…',
      resolveError: 'No pudimos resolver la dirección. Igual puedes confirmar.',
      outsideLima: 'Ese punto está fuera de Lima Metropolitana',
      confirm: 'Confirmar',
    },
  },

  /** Ruta + cotización (previsualización antes de confirmar). */
  quote: {
    title: 'Elige tu VEO',
    calculating: 'Trazando la mejor ruta…',
    error: 'No pudimos cotizar el viaje. Inténtalo de nuevo.',
    distance: 'Distancia',
    duration: 'Tiempo',
    confirm: 'Confirmar VEO',
    requesting: 'Solicitando…',
    selectOption: 'Selecciona una categoría para continuar.',
    /** Gate de seguridad: el pasajero debe verificar su identidad antes del primer viaje. */
    kycRequired: 'Verifica tu identidad para pedir tu primer viaje.',
    /** ADR 013 · Fase B: la oferta elegida se deshabilitó entre el quote y el create (carrera). */
    offeringUnavailable:
      'Esta oferta ya no está disponible. Actualizamos las opciones.',
    eta: 'ETA {{minutes}} min',
    /** Tipos de vehículo en las opciones de tarifa (Ola 2B · tier moto-taxi). */
    vehicle: {
      moto: 'Mototaxi',
      car: 'Auto',
    },
    cheapest: 'Más barato',
    /** Etiqueta del total en el desglose de tarifa (p. ej. con recargo de modo niño). */
    total: 'Total',
    /** Preview del crédito de referido aplicado a la tarifa (Lote C3). */
    referralCredit: 'Crédito de referido',
    youPay: 'Pagas',
  },

  /**
   * Nombres de las ofertas del catálogo (ADR 013): la app resuelve `options[].labelKey`
   * (`offering.veo_moto.name`) acá. Mismos textos que `OFFERING_DISPLAY_NAMES` del public-bff
   * (compat server-side): si la app no conoce una clave (oferta más nueva), cae al `name` del quote.
   */
  offering: {
    veo_moto: {name: 'VEO Moto'},
    veo_economico: {name: 'VEO Económico'},
    // F2.3 (ADR-017 §1.2) · Confort renombrado a "Normal" (solo el nombre visible; el id veo_confort es contrato).
    veo_confort: {name: 'VEO Normal'},
    veo_xl: {name: 'VEO XL'},
    veo_premium: {name: 'VEO Premium'},
    // B5-vert · verticales especiales: codeadas pero OCULTAS (defaultEnabled:false). El i18n nativo
    // existe para cuando el admin las habilite (la feature pagable); mientras estén ocultas el quote no las
    // cotiza, así que estas claves no se renderizan. Mismos textos que OFFERING_DISPLAY_NAMES del public-bff.
    veo_ambulance: {name: 'VEO Ambulancia'},
    veo_tow: {name: 'VEO Grúa'},
    veo_mechanic: {name: 'VEO Mecánico'},
  },

  /** PUJA · "proponé tu precio" (ADR 010 · regateo inverso). */
  puja: {
    title: 'Tu viaje',
    offerYourFare: 'OFRECE TU TARIFA',
    decrease: 'Bajar la oferta',
    increase: 'Subir la oferta',
    suggestedAndMin: 'Sugerido {{suggested}} · mínimo {{min}}',
    minOnly: 'Mínimo {{min}}',
    atFloor: 'Es la tarifa mínima para esta zona.',
    tollsApart: 'Peajes y tasas de aeropuerto se pagan aparte.',
    searchDriver: 'Buscar conductor · {{price}}',
    specialRequests: 'Solicitudes para el conductor',
    request: {
      PET: 'Mascota',
      LUGGAGE: 'Equipaje',
      CHILD_SEAT: 'Silla de niño',
    },
  },

  /** PUJA · board de ofertas en vivo (ADR 010). */
  offers: {
    title: '{{count}} conductores respondieron',
    chooseHint: 'Elige por precio, rating o llegada.',
    live: 'En vivo',
    driver: 'Conductor',
    acceptsPrice: 'Acepta tu precio',
    proposesOther: 'Propone otro',
    etaMin: 'llega en {{minutes}} min',
    choose: 'Elegir',
    view: 'Ver',
    waitingTitle: 'Buscando conductores…',
    /** Countdown visual honesto de la ventana de puja (UI, no decide la fase: la fase la manda el backend). */
    waitingCountdown: 'Buscando conductores… {{time}}',
    waitingBody: 'Te avisamos apenas alguien responda tu oferta.',
    /** Al llegar el countdown a 0 esperamos el EXPIRED real del backend (spinner honesto, sin botón roto). */
    takingLongTitle: 'Esto está tardando…',
    takingLongBody:
      'Seguimos esperando respuesta. En unos segundos te mostramos cómo seguir.',
    noneTitle: 'Sin ofertas por ahora',
    noneBody:
      'Nadie respondió tu oferta. Puedes intentar con una tarifa más alta.',
    cancel: 'Cancelar la búsqueda',
    reconnecting: 'Reconectando…',
    actionError: 'No pudimos completar la acción. Inténtalo de nuevo.',
  },

  /** PUJA · detalle de contraoferta (ADR 010). */
  counter: {
    proposedOther: 'Propone otro precio',
    yourOffer: 'Tu oferta',
    driverCounter: 'Contraoferta del conductor',
    accept: 'Aceptar {{price}}',
    wait: 'Esperar otra oferta',
    goneTitle: 'Esta oferta ya no está disponible',
    goneBody: 'El conductor la retiró. Vuelve al listado para elegir otra.',
    back: 'Volver al listado',
    acceptError: 'No pudimos aceptar la oferta. Quizá ya no está disponible.',
  },

  /** PUJA · sin ofertas (EXPIRED) → re-pujar más alto (ADR 010 #12) o salir, in-sheet. */
  noOffers: {
    title: 'No hubo ofertas esta vez',
    body: 'Nadie aceptó tu oferta de {{price}}. Ofrece un poco más para conseguir conductor.',
    /** Mientras el piso (oferta actual) aún no llegó: explicación honesta sin precio. */
    bodyNoPrice:
      'Nadie aceptó tu oferta. Ofrece un poco más para conseguir conductor.',
    rebid: 'Re-pujar · {{price}}',
    /** Re-pujar antes de saber el piso: sin precio (el botón se habilita al llegar la oferta actual). */
    rebidNoPrice: 'Re-pujar',
    /** Salida local: abandona la puja expirada y vuelve al home (no es un cancel server-side). */
    exit: 'Salir',
    cancel: 'Cancelar el viaje',
    error: 'No pudimos reabrir tu puja. Inténtalo de nuevo.',
    /**
     * 409 de estado tras agotar los reintentos: el backend aún está cerrando la búsqueda anterior (el
     * sweeper expira el board recién a los ~60s + margen). Mensaje honesto, NO error críptico.
     */
    closingSearch:
      'Todavía estamos cerrando la búsqueda anterior. Inténtalo de nuevo en unos segundos.',
  },

  /** Paradas intermedias del trayecto (Ola 2B · paradas múltiples, máx 3). */
  waypoints: {
    title: 'Paradas del viaje',
    origin: 'Origen',
    destination: 'Destino',
    stopLabel: 'Parada {{index}}',
    add: '+ Agregar parada',
    addTitle: 'Agregar parada',
    remove: 'Quitar parada',
    max: 'Puedes agregar hasta 3 paradas.',
    pickPlaceholder: 'Busca la dirección de la parada',
    empty: 'Sin paradas intermedias',
  },

  /** Programar viaje para después (Ola 2B · viajes programados). */
  schedule: {
    cta: 'Programar para después',
    now: 'Viajar ahora',
    title: 'Programa tu viaje',
    subtitle: 'Elige el día y la hora. Te asignaremos un conductor a tiempo.',
    day: 'Día',
    time: 'Hora',
    today: 'Hoy',
    tomorrow: 'Mañana',
    confirm: 'Programar viaje',
    scheduledFor: 'Programado para {{when}}',
    tooSoon: 'Programa con al menos 15 minutos de anticipación.',
    tooFar: 'Solo puedes programar hasta 7 días en adelante.',
    confirmedTitle: 'Viaje programado',
    confirmedBody:
      'Tu viaje quedó programado para {{when}}. Lo verás en “Mis viajes programados”.',
    viewScheduled: 'Ver mis viajes programados',
  },

  /** Listado y gestión de viajes programados (GET /trips/scheduled, DELETE /trips/:id/schedule). */
  scheduled: {
    title: 'Mis viajes programados',
    entry: 'Viajes programados',
    when: 'Programado para',
    fare: 'Tarifa estimada',
    route: '{{origin}} → {{destination}}',
    stopsOne: '1 parada intermedia',
    stopsMany: '{{count}} paradas intermedias',
    cancel: 'Cancelar viaje',
    cancelTitle: '¿Cancelar viaje programado?',
    cancelBody: 'Si cancelas con antelación no se aplica penalidad.',
    cancelConfirm: 'Sí, cancelar',
    keep: 'Mantener',
    cancelError: 'No pudimos cancelar el viaje. Inténtalo de nuevo.',
    empty: 'No tienes viajes programados',
    emptySubtitle: 'Programa un viaje desde la cotización y aparecerá aquí.',
    loadError: 'No pudimos cargar tus viajes programados.',
  },

  trip: {
    driver: 'Conductor',
    vehicle: 'Vehículo',
    // Gate de verificación facial contextual (antes de pedir el viaje). Tuteo peruano.
    kycGateTitle: 'Verifica tu identidad',
    kycGateBody:
      'Por tu seguridad, confirmamos que eres tú con una verificación facial. Es un paso único y toma menos de un minuto.',
    kycGateCta: 'Verificar ahora',
    kycPendingTitle: 'Estamos verificando tu identidad',
    kycPendingBody:
      'Tu verificación está en revisión. Te avisamos apenas esté lista para que puedas pedir tu viaje.',
    kycPendingPill: 'En revisión',
    eta: 'Llegada estimada',
    etaMinutes: '{{minutes}} min',
    etaUnknown: 'Calculando…',
    searchingTitle: 'Buscando tu conductor',
    searchingBody:
      'Estamos contactando a los conductores cercanos. Te avisaremos al asignar uno.',
    plate: 'Placa',
    rating: '{{stars}} ★',
    cancel: 'Cancelar viaje',
    cancelTitle: '¿Cancelar el viaje?',
    cancelBody:
      'Si cancelas podría aplicarse una penalidad según el estado del viaje.',
    cancelReasonLabel: 'Motivo (opcional)',
    keepTrip: 'Mantener viaje',
    changeDestination: 'Cambiar destino',
    changeDestinationTitle: 'Nuevo destino',
    changeDestinationBody: 'Toca el mapa para elegir el nuevo destino.',
    panicButton: 'Emergencia',
    recording: 'GRABANDO',
    cabinVideoTitle: 'Cámara del habitáculo',
    cabinVideoUnavailable: 'La cámara no está disponible en este momento.',
    cabinVideoNative: 'El visor en vivo se habilita en la app instalada.',
    reconnecting: 'Reconectando…',
    live: 'EN VIVO',
    waitingDriver: 'Buscando un conductor para ti…',
    arrived: 'Tu conductor llegó',
    completedTitle: 'Viaje completado',
    failedBody:
      'El viaje se interrumpió y no pudo completarse. No se te cobró.',
    payNow: 'Pagar viaje',
    rateNow: 'Calificar conductor',
    share: 'Compartir viaje',
    shareTitle: 'Sigue mi viaje en VEO',
    shareMessage:
      'Estoy en un viaje con VEO. Sigue mi recorrido en vivo aquí: {{url}}',
    shareError:
      'No pudimos generar el enlace para compartir. Inténtalo de nuevo.',
    // Enlace de seguimiento ACTIVO (kill-switch): mientras el enlace vive, el pasajero puede dejar de
    // compartir su ubicación al instante. Honesto: el efecto lo aplica el server (revoca el enlace).
    sharingActive: 'Compartiendo ubicación',
    shareExpiresIn: 'Expira en {{countdown}}',
    revokeShare: 'Dejar de compartir',
    revokeShareTitle: '¿Dejar de compartir tu ubicación?',
    revokeShareConfirm: 'Dejar de compartir',
    revokeShareBody:
      'Cualquiera con el enlace dejará de ver tu ubicación al instante. Esto revoca el enlace que compartiste en este viaje.',
    revokeShareError: 'No pudimos revocar el enlace. Inténtalo de nuevo.',
    revokeShareKeep: 'Seguir compartiendo',
    shareRevokedBanner: 'Dejaste de compartir tu ubicación.',

    // Parada negociada en viaje (Lote C3): el pasajero propone una parada durante el viaje en curso; el
    // conductor la acepta o rechaza. El server calcula el costo adicional y la ruta (nunca el cliente).
    addStop: 'Agregar parada',
    addStopPickTitle: 'Elige la parada',
    addStopPickBody: 'Toca el mapa para marcar dónde quieres parar.',
    addStopConfirm: 'Proponer parada',
    addStopCancel: 'Cancelar',
    addStopProposing: 'Enviando tu propuesta…',
    addStopWaitingTitle: 'Esperando al conductor',
    addStopWaitingBody:
      'Le propusimos tu parada. Si la acepta, se actualizan la ruta y la tarifa.',
    addStopCountdown: 'Vence en {{seconds}} s',
    addStopDelta: 'Costo adicional {{amount}}',
    addStopNewFare: 'Nueva tarifa {{amount}}',
    addStopAcceptedTitle: 'Parada agregada',
    addStopAcceptedBody:
      'Tu conductor aceptó. La ruta y la tarifa ya se actualizaron.',
    addStopRejectedTitle: 'Parada rechazada',
    addStopRejectedBody:
      'Tu conductor no agregó la parada. El viaje continúa igual.',
    addStopExpiredTitle: 'La propuesta venció',
    addStopExpiredBody:
      'No recibimos respuesta a tiempo. Puedes intentarlo de nuevo.',
    addStopError: 'No pudimos enviar tu propuesta. Inténtalo de nuevo.',
    addStopDismiss: 'Entendido',
  },

  /**
   * Franja de estado del viaje (TripStatusStrip): el texto ES el contenido informativo (la animación
   * del vehículo es decorativa). Una etiqueta por fase del viaje activo.
   */
  tripStrip: {
    /** Conductor en camino al recojo (enRoute/arriving). Vehículo deslizándose →. */
    enRoute: 'En camino',
    /** Conductor llegó al punto de recogida (arrived). Vehículo quieto al inicio, con pulso. */
    arrived: 'Tu conductor llegó',
    /** Viaje en curso (inProgress). Vehículo deslizándose →. */
    inProgress: 'En viaje',
  },

  /** Cámara del viaje a pantalla completa (Ola 2A · seguridad). */
  cameraLive: {
    recLive: 'REC · EN VIVO',
    analyzing: 'Analizando',
    cardTitle: 'Cámara de tu viaje',
    cardSubtitle: 'Cifrada de extremo a extremo',
    viewingNow: 'La estás viendo en vivo',
    controlButton: 'Control de cámara · ¿quién puede ver?',
    openFullscreen: 'Ver cámara en pantalla completa',
    connecting: 'Conectando con la cámara…',
    error:
      'La cámara en vivo no está disponible en este momento. La grabación del viaje sigue activa.',
    noPermission:
      'El video en vivo no está disponible para este viaje todavía.',
  },

  /** Control de cámara · privacidad (Ola 2A). Persistencia LOCAL por hueco de backend. */
  cameraControl: {
    intro:
      'Por seguridad, tú decides quién ve la cámara de tu viaje. Nadie más puede acceder.',
    backendNotice:
      'Próximamente: tu preferencia se guarda en este dispositivo y se aplicará cuando el servicio de compartir cámara esté disponible.',
    masterTitle: 'Compartir cámara con mi familia',
    masterSubtitle: 'Tus contactos verificados la ven en vivo',
    whoCanView: '¿Quién puede ver?',
    noVerifiedContacts:
      'No tienes contactos verificados. Verifica a un contacto de confianza para poder compartir la cámara.',
    parentalTitle: 'Control parental',
    parentalBody:
      'Si viaja un menor, un adulto de confianza ve la cámara durante todo el viaje — aunque el menor no controle el teléfono.',
    encryptionNote:
      'Grabación cifrada. El equipo de VEO solo accede con doble autorización y queda auditado.',
    save: 'Guardar',
    saved: 'Preferencias guardadas',
    saveError: 'No pudimos guardar tus preferencias. Inténtalo de nuevo.',
  },

  tripStatus: {
    SCHEDULED: 'Programado',
    REQUESTED: 'Solicitado',
    MATCHING: 'Buscando conductor',
    ASSIGNED: 'Conductor asignado',
    ACCEPTED: 'Conductor en camino',
    ARRIVING: 'Llegando',
    ARRIVED: 'Conductor llegó',
    IN_PROGRESS: 'En viaje',
    COMPLETED: 'Completado',
    CANCELLED: 'Cancelado',
    REASSIGNING: 'Buscando otro conductor',
    EXPIRED: 'Sin ofertas',
    FAILED: 'Viaje interrumpido',
  },

  history: {
    /** Vacío CON ALMA: el dueño detesta los vacíos genéricos. Copy cálido en tuteo + CTA a pedir viaje. */
    emptyTitle: 'Aún no tienes viajes',
    emptyBody:
      'Tu primer recorrido con VEO aparecerá aquí, con su recibo y todo.',
    emptyCta: 'Pide tu primer VEO',
    serverNote: 'Estás al día. Aquí está todo tu historial con VEO.',
    loadingMore: 'Cargando más viajes…',
    refresh: 'Actualizar',
    /** Headers de los tramos temporales de la lista (mata la monotonía de la lista plana). */
    section: {
      today: 'Hoy',
      week: 'Esta semana',
      earlier: 'Anteriores',
    },
    /** Etiqueta del día de la fila (relativa hasta ayer; luego fecha corta). */
    dayToday: 'Hoy',
    dayYesterday: 'Ayer',
    /** Extremo de origen del riel cuando no hay dirección guardada: la hora real de salida. */
    departedAt: 'Salida {{time}}',
    minutes: '{{minutes}} min',
    /** Tier del vehículo (icono + texto en la cabecera de la fila). */
    tier: {
      CAR: 'Auto',
      MOTO: 'Moto',
    },
    /** Sello de calificación en la fila: invitación cálida (sin calificar) y valor compacto (calificado). */
    rateNudge: 'Califica tu viaje',
    ratedValue: 'Calificaste con {{stars}} estrellas',
    /** A11y: etiqueta hablada de la fila completa. */
    rowLabel: '{{day}} {{time}}, {{fare}}, {{status}}',
    // Claves antiguas conservadas por compatibilidad (lista plana legacy). No usar en UI nueva.
    empty: 'Aún no tienes viajes',
    emptySubtitle: 'Cuando pidas tu primer viaje aparecerá aquí.',
  },

  panic: {
    title: '¿Necesitas ayuda?',
    subtitle:
      'Enviaremos tu ubicación a nuestro equipo de seguridad y a tus contactos de confianza.',
    trigger: 'Enviar alerta',
    sending: 'Enviando alerta…',
    sentTitle: 'Alerta enviada',
    sentBody: 'Estamos contigo. Mantén la calma.',
    alertId: 'ID de alerta',
    deduplicated: 'Ya teníamos esta alerta registrada.',
    close: 'Cerrar',
    back: 'Volver al viaje',
    errorNoTrip: 'Solo puedes activar el pánico durante un viaje en curso.',
    errorLocation:
      'No pudimos obtener tu ubicación. Se habilita en la app instalada.',
    errorSign: 'La firma de seguridad se habilita en la app instalada.',
    errorGeneric: 'No pudimos enviar la alerta. Inténtalo de nuevo.',
    // Escalamiento del disparo SILENCIOSO fallido (SilentPanicDispatcher agotó reintentos):
    // la pantalla debe decir la verdad de entrada, no aterrizar en el estado neutro.
    escalatedTitle: 'No pudimos enviar tu alerta silenciosa',
    escalatedBody:
      'Tu alerta aún no llegó a nuestro equipo de seguridad. Reintenta ahora con el botón de abajo.',
    volumeHintSoon:
      'Próximamente: activar la alerta presionando 3 veces el botón de volumen, sin tocar la pantalla.',
  },

  contacts: {
    subtitle: 'Hasta 3 personas que recibirán tus alertas de seguridad.',
    empty: 'Sin contactos de confianza',
    emptySubtitle: 'Agrega a alguien de confianza para tus viajes.',
    add: 'Agregar contacto',
    addTitle: 'Nuevo contacto de confianza',
    nameLabel: 'Nombre',
    phoneLabel: 'Teléfono',
    relationshipLabel: 'Parentesco',
    relationshipHelper: 'Ej.: madre, pareja, amigo.',
    emailLabel: 'Correo (opcional)',
    sendOtp: 'Enviar código al contacto',
    verifyTitle: 'Verificar contacto',
    verifyBody: 'Ingresa el código de 6 dígitos que enviamos a {{phone}}.',
    otpLabel: 'Código del contacto',
    verify: 'Verificar',
    resend: 'Reenviar código',
    remove: 'Eliminar contacto',
    removeTitle: '¿Eliminar contacto?',
    removeBody:
      'Podría aplicarse un periodo de espera de 24 h antes de poder volver a agregarlo.',
    verified: 'Verificado',
    pending: 'Pendiente de verificar',
    maxReached: 'Alcanzaste el máximo de 3 contactos.',
    invalidPhone: 'Ingresa un número peruano válido.',
    invalidName: 'Ingresa un nombre (2 a 80 caracteres).',
    invalidRelationship: 'Ingresa el parentesco (2 a 40 caracteres).',
    invalidEmail: 'Ingresa un correo válido.',
    addError: 'No pudimos agregar el contacto. Inténtalo de nuevo.',
    verifyError: 'Código incorrecto o vencido.',
  },

  childMode: {
    subtitle:
      'Activa un código que el conductor deberá confirmar al iniciar el viaje del menor.',
    enable: 'Activar modo niño',
    codeLabel: 'Código de modo niño',
    codeHelper: 'De 4 a 6 dígitos. No lo compartas con el conductor.',
    invalidCode: 'El código debe tener entre 4 y 6 dígitos.',
    active: 'Modo niño activado',
    inactive: 'Modo niño desactivado',
    explanation:
      'El código nunca se muestra al conductor; el sistema valida un hash en el servidor.',
    /** Línea del desglose de tarifa (precio FIJO): "Recargo modo niño". El monto va aparte. */
    feeLine: 'Recargo modo niño',
    /** Aviso del recargo al activar el toggle (solo informa; el recargo aplica en viajes de precio fijo). */
    feeNotice:
      'En viajes de precio fijo se suma un recargo de {{amount}}. En modo puja no hay recargo.',
  },

  kyc: {
    kycLabel: 'Verificación de identidad',
    title: 'Verifica tu identidad',
    subtitle:
      'Es una prueba de vida: vas a seguir un movimiento simple con tu rostro (no es una foto). Rápido y seguro. Mantén buena luz y quítate gorra o lentes.',
    /** Texto del intro idle, sobre el ícono, antes de abrir la cámara. */
    introHint:
      'Vamos a confirmar que eres una persona real con un movimiento guiado.',
    start: 'Iniciar verificación',
    capture: 'Verificar',
    retry: 'Reintentar',
    capturing: 'Verificando',
    livenessHint:
      'Sigue la instrucción en pantalla y mantén el rostro dentro del óvalo.',
    /** Guía en vivo (detección facial real). */
    centerFace: 'Centra tu rostro dentro del óvalo',
    faceDetected: 'Rostro detectado',
    moveDetected: '¡Movimiento detectado!',
    holdStill: 'No te muevas un instante…',
    noFrontCamera: 'No encontramos la cámara frontal de este dispositivo.',
    openSettings: 'Abrir Ajustes',
    submitting: 'Enviando tu verificación…',
    preparingChallenge: 'Preparando tu verificación…',
    followInstruction: 'Sigue la instrucción',
    challengeErrorTitle: 'No pudimos preparar la verificación',
    challengeErrorBody:
      'No pudimos obtener la acción a realizar. Revisa tu conexión e inténtalo de nuevo.',
    challengeExpiredTitle: 'La verificación expiró',
    challengeExpiredBody:
      'Pasó demasiado tiempo. Vuelve a iniciar para obtener una nueva acción.',
    captureUnavailableTitle: 'Captura no disponible',
    captureUnavailableBody:
      'Este dispositivo aún no puede capturar la foto para la verificación. Vuelve a intentarlo más tarde.',
    permissionBlockedTitle: 'Permiso de cámara desactivado',
    permissionBlockedBody:
      'Activa el permiso de cámara para VEO en los ajustes del sistema para continuar.',
    cameraError:
      'No pudimos abrir la cámara. Revisa el permiso e inténtalo de nuevo.',
    submitErrorTitle: 'No se pudo enviar',
    submitErrorBody: 'No pudimos enviar tu verificación. Inténtalo de nuevo.',
    submitErrorPending:
      'La verificación de identidad aún no está disponible. Inténtalo más tarde.',
    submitErrorEmpty: 'No capturamos una imagen válida. Vuelve a intentarlo.',
    rejectionReason: 'Motivo',
    resultApprovedTitle: 'Identidad verificada',
    resultApprovedBody:
      'Tu identidad fue confirmada. ¡Ya puedes viajar con VEO!',
    resultPendingTitle: 'Verificación en revisión',
    resultPendingBody:
      'Recibimos tu verificación y la estamos revisando. Te avisaremos cuando esté lista.',
    resultRejectedTitle: 'No pudimos verificarte',
    resultRejectedBody:
      'Tu verificación no pasó. Revisa la iluminación y vuelve a intentarlo.',
  },

  payments: {
    /** Subtítulo de la pantalla: cuenta el modelo (un solo cobro, al terminar el viaje). */
    subtitle: 'Elige cómo pagas; el cobro es al terminar el viaje.',
    /**
     * Error de RED al leer la afiliación Yape (no es "sin Yape": la consulta FALLÓ). Degradación honesta:
     * nunca mostramos "Vincular" cuando en realidad no pudimos saber tu estado. Reintentable.
     */
    loadError: 'No pudimos cargar tus métodos de pago. Inténtalo de nuevo.',
    methodsTitle: 'Métodos disponibles',
    default: 'Por defecto',
    /** Pill en la fila del método elegido por defecto (patrón instrumentos). */
    defaultPill: 'Predeterminado',
    setDefault: 'Usar por defecto',
    method: {
      YAPE: 'Yape',
      PLIN: 'Plin',
      CASH: 'Efectivo',
      CARD: 'Tarjeta',
      PAGOEFECTIVO: 'PagoEfectivo',
    },
    /**
     * UNA línea de experiencia por método en la pantalla de métodos (patrón instrumentos). Cuenta CÓMO
     * se paga, no qué es. Yape sin vincular invita; los demás describen el momento del cobro.
     */
    line: {
      YAPE: 'Se cobra solo al terminar el viaje',
      PLIN: 'Escaneas el QR al terminar',
      CASH: 'Le pagas al conductor',
      CARD: 'Pagas con link seguro al terminar',
      PAGOEFECTIVO: 'Código para pagar en bancos y agentes',
    },
    /**
     * Subtítulo corto por método (selector al pedir · handoff Payment). Para YAPE distinguimos
     * LÉXICAMENTE (TASK 4): sin afiliación es "pago una vez con QR"; con afiliación activa la fila
     * muestra `hintYapeAuto` ("se cobra solo al terminar"). NUNCA "automático" en el one-shot.
     */
    hint: {
      YAPE: 'Pagas con QR al terminar',
      PLIN: 'Pago con QR',
      CASH: 'Paga al bajar',
      CARD: 'Visa · Mastercard',
      PAGOEFECTIVO: 'Código para pagar en bancos y agentes',
    },
    /** Subtítulo de la fila YAPE cuando la afiliación está ACTIVA: cobro On-File (se cobra solo). */
    hintYapeAuto: 'Se cobra solo al terminar el viaje',
    /**
     * Señal sutil en la fila del quoting cuando el cobro automático con Yape está activo (afiliación
     * On-File). SOLO para el Yape VINCULADO; jamás para "pagar con Yape una vez" (QR/deepLink al final).
     */
    autoBadge: 'Automático',
    /**
     * Nombre del método YAPE en las superficies, distinguido por estado (TASK 4):
     *  - `nameYapeAuto`: afiliación ACTIVA → "Yape · automático" (On-File, se cobra solo).
     *  - el nombre a secas (`method.YAPE` = "Yape") cubre el one-shot (QR/deepLink una vez).
     */
    nameYapeAuto: 'Yape · automático',
    /** Selector de método PARA ESTE VIAJE (al pedir): la elección no pisa el default del perfil. */
    rowLabel: 'Método de pago',
    selectTitle: 'Método de pago',
    selectSubtitle:
      'Elige cómo pagar este viaje. No cambia tu método predeterminado.',
    /**
     * TASK 2 · Pista del método PREDETERMINADO dentro del selector: la fila que coincide con tu
     * predeterminado lleva esta marca, para que SIEMPRE se vea cuál es "con qué pagas siempre".
     */
    defaultHere: 'Tu predeterminado',
    /**
     * Marca de SUGERENCIA en el selector de resolución de pago (variante `compact`): destaca el método
     * que recomendamos (el predeterminado del perfil) sin convertir la fila en un radio. Guía, no obliga.
     */
    suggested: 'Sugerido',
    /**
     * TASK 2 · Toggle sutil bajo las filas: si lo marcas, el método elegido pasa a ser tu predeterminado
     * (setDefault). Sin marcar, la elección aplica SOLO a este viaje (no pisa tu preferencia).
     */
    rememberDefault: 'Recordar como mi método predeterminado',
    /** Agregar tarjeta — sin backend (/cards). Degradación honesta: nunca simula guardar. */
    addCard: 'Agregar tarjeta',
    addCardComingSoonTitle: 'Próximamente',
    addCardComingSoon:
      'Agregar una tarjeta estará disponible pronto. Por ahora paga con Yape, Plin o efectivo.',
    payTitle: 'Pago del viaje',
    amount: 'Monto a pagar',
    tip: 'Propina (opcional)',
    payNow: 'Pagar ahora',
    paying: 'Procesando pago…',
    paid: 'Pago confirmado',
    payError: 'No pudimos procesar el pago. Inténtalo de nuevo.',
    cashNote: 'Paga en efectivo directamente al conductor.',
    confirmCash: 'Confirmar pago en efectivo',
    cashConfirmed: 'Pago en efectivo confirmado',
    status: 'Estado',
    /** Desglose del pago confirmado (pantalla de éxito). */
    breakdownFare: 'Tarifa acordada',
    breakdownTip: 'Propina',
    breakdownTotal: 'Total',
    rateTrip: 'Calificar viaje',

    /**
     * Pago automático con Yape (afiliación Yape On File). El cobro se hace SOLO al terminar cada viaje
     * (cargo automático). Copy explícito de seguridad: qué significa y cómo desactivarlo siempre visible.
     */
    auto: {
      /** Acción en la fila Yape (sin vincular). */
      link: 'Vincular',
      /** Fila Yape vinculado: línea de experiencia con teléfono enmascarado y "pago automático". */
      linkedLine: 'Tu Yape · {{phone}} · pago automático',
      linkedLineNoPhone: 'Tu Yape vinculado · pago automático',
      /** Fila Yape en proceso (tras el deepLink, esperando confirmación). */
      processLine: 'Esperando confirmación en Yape…',

      /** Sheet de vinculación (la joya): título + 2 líneas con el consent integrado al copy. */
      linkTitle: 'Vincula tu Yape',
      linkIntro1:
        'Se cobra solo al terminar cada viaje, sin abrir la app de pago.',
      linkIntro2: 'Lo desactivas cuando quieras desde aquí mismo.',
      /** Único campo del sheet: documento + selector de tipo discreto. */
      docTypeDN: 'DNI',
      docTypeCE: 'CE',
      docTypePP: 'Pasaporte',
      documentLabel: 'Número de documento',
      documentHelperDN: '8 dígitos.',
      documentHelperOther: 'Tal como figura en tu documento.',
      /** Nota bajo el campo de documento (primera vez): se persiste en el perfil para el próximo tap. */
      documentSavedNote:
        'Lo guardamos en tu perfil; la próxima vez vinculas con un solo toque.',
      /** 502 transitorio del gateway (Cloudflare del sandbox) que persiste tras el reintento automático. */
      upstreamBusy:
        'El servicio de Yape está ocupado. Inténtalo en un momento.',
      openYape: 'Abrir Yape',
      submitting: 'Abriendo…',
      cancel: 'Cancelar',
      close: 'Cerrar',
      /** Esperando aprobación en la app Yape (tras el deepLink). */
      waitingTitle: 'Confirma en tu app de Yape',
      waitingBody:
        'Abre Yape y aprueba la vinculación. Esta pantalla se actualiza sola.',
      waitingTimeoutTitle: 'Seguimos esperando',
      waitingTimeoutBody:
        'Vuelve cuando confirmes en Yape; se activará automáticamente.',
      /**
       * No se pudo ABRIR Yape automáticamente (openURL rechazó el deepLink de afiliación). Copy HONESTO:
       * no culpamos al usuario (en sandbox el esquema no está registrado aunque tenga Yape instalada).
       */
      openFailedTitle: 'No pudimos abrir Yape automáticamente',
      openFailedBody: 'Abre tu app de Yape y aprueba la vinculación desde ahí.',
      /** Vinculación lista (ACTIVE) → cierre del sheet con feedback sutil. */
      linkedTitle: 'Yape vinculado',
      linkedBody: 'Listo. Tus viajes se cobran solos al terminar con tu Yape.',

      /**
       * TASK 1 · Al quedar ACTIVE NO seteamos el predeterminado solos: PREGUNTAMOS. Paso de confirmación
       * dentro del sheet. Distingue los 3 conceptos: "vinculado" (automático) ≠ "predeterminado" (con qué
       * pagas siempre). El usuario decide; ningún cambio silencioso de su preferencia.
       */
      askDefaultTitle: 'Yape quedó vinculado',
      askDefaultBody:
        '¿Quieres usarlo como tu método predeterminado para tus próximos viajes?',
      askDefaultYes: 'Sí, usar Yape',
      askDefaultNo: 'Ahora no',
      /** Tras elegir "Sí": confirmación breve de que el predeterminado quedó en Yape. */
      askDefaultDoneTitle: 'Yape es tu método predeterminado',
      askDefaultDoneBody:
        'Lo cambias cuando quieras desde tus métodos de pago.',
      /** Tras "Ahora no": el vínculo quedó, pero el predeterminado no se tocó. */
      askDefaultKeptTitle: 'Yape vinculado',
      askDefaultKeptBody:
        'Tu método predeterminado sigue igual. Eliges Yape cuando lo necesites.',

      /** Sheet de gestión del Yape vinculado (tap en la fila): predeterminado + desvincular. */
      manageTitle: 'Tu Yape',
      isDefault: 'Predeterminado',
      makeDefault: 'Usar como predeterminado',
      unlink: 'Desvincular Yape',
      /** Confirmación destructiva de la baja. */
      unlinkConfirmTitle: '¿Desvincular tu Yape?',
      unlinkConfirmBody:
        'Dejaremos de cobrar tus viajes automáticamente. Seguirás pagando con Yape escaneando el QR al terminar cada viaje.',
      unlinkConfirm: 'Sí, desvincular',
      unlinking: 'Desvinculando…',

      /** Estado PROCESS (la pantalla, fuera del sheet). */
      processTitle: 'Vinculación en proceso',
      processBody:
        'Estamos confirmando tu Yape. Te avisaremos cuando esté lista.',
      /** Estado EXPIRED → venció, reintentar. */
      expiredTitle: 'La vinculación venció',
      expiredBody:
        'Venció antes de confirmarse. Prueba de nuevo cuando quieras.',
      retry: 'Vincular de nuevo',
      /** 422: el perfil no tiene nombre → CTA al perfil (no error de campo). */
      profileIncompleteTitle: 'Completa tu nombre primero',
      profileIncompleteBody:
        'Para vincular tu Yape necesitamos tu nombre. Complétalo en tu perfil y vuelve.',
      goToProfile: 'Ir a mi perfil',
      /**
       * Capacidad NO habilitada en el comercio (422 GATEWAY_CAPABILITY_UNAVAILABLE): NO es error ni
       * transitorio. Info honesta y calma, sin "reintenta" (reintentar nunca funcionará hasta que el
       * proveedor habilite el producto). El CTA "Abrir Yape" se oculta en este estado.
       */
      unsupportedTitle: 'La vinculación de Yape todavía no está disponible',
      unsupportedBody:
        'La estamos activando. Mientras tanto, paga con Yape, Plin o efectivo al terminar cada viaje.',
      /** Error genérico de red (no el 409/422 del entorno). */
      error: 'No pudimos completar la operación. Inténtalo de nuevo.',
    },
  },

  /**
   * Cierre del viaje (recibo del cobro AUTOMÁTICO). El cobro se genera al completar el viaje (consumer
   * Kafka): la app NO elige método ni "paga" — solo refleja el estado del cobro y, si es efectivo,
   * confirma el lado del pasajero. Textos es-PE alineados al handoff de diseño.
   */
  settlement: {
    /** Cargando el recibo (primer fetch). */
    loading: 'Cargando tu recibo…',
    /** El cobro aún no existe en el server (el consumer puede demorar): poll suave. */
    processing: 'Procesando tu pago…',
    processingDigital: 'Procesando pago…',
    processingHint: 'Esto puede tardar unos segundos.',
    /** El poll agotó el tiempo y el recibo sigue sin aparecer. */
    timeoutTitle: 'No pudimos cargar tu recibo',
    timeoutBody: 'El cobro está tardando más de lo normal. Puedes reintentar.',
    /** Pago digital ya capturado. */
    paidTitle: '¡Pago realizado!',
    paidBody: 'Se cobró {{amount}} · {{method}}',
    /** Efectivo. */
    cashTitle: 'Paga en efectivo',
    cashBody: 'Entrega {{amount}} al conductor. Él confirma al recibir.',
    cashBanner:
      '¿Sin cambio exacto? Avísale al conductor; también puedes pagar la diferencia con Yape.',
    confirmCash: 'Confirmar efectivo',
    confirmingCash: 'Confirmando…',
    /** Efectivo confirmado por el pasajero pero el conductor aún no confirma (confirmación bilateral). */
    cashAwaitingDriverTitle: 'Esperando al conductor',
    cashAwaitingDriverBody:
      'Confirmaste el pago. El conductor debe confirmar que lo recibió para cerrar el cobro.',
    confirmLater: 'Confirmar después',
    /** Cobro fallido / deuda — estado honesto, nunca data falsa. */
    failedTitle: 'No pudimos procesar el cobro',
    failedBody:
      'Lo intentaremos de nuevo automáticamente. No se te cobró dos veces.',
    debtTitle: 'Pago pendiente',
    debtBody:
      'El cobro quedó pendiente. Lo regularizaremos en tu próximo viaje.',
    /** Cobro reembolsado TOTAL — estado honesto, neutral: ni "pagado" ni propina. */
    refundedTitle: 'Este viaje fue reembolsado',
    refundedBody:
      'Se te devolvió {{amount}}. No hay nada que pagar por este viaje.',
    /** Cobro reembolsado PARCIAL — honesto: NO es "pagado" pleno; se devolvió parte del importe. */
    partialRefundTitle: 'Reembolso parcial',
    partialRefundBody:
      'Se te devolvió parte del importe de este viaje. Revisa el detalle abajo.',
    /** Propina post-viaje (solo si tipCents === 0). 100% va al conductor. */
    tipPrompt: 'Propina (opcional · 100% al conductor)',
    /**
     * Viaje en EFECTIVO: la tarifa se la das en mano, pero la propina por estos chips se cobra DIGITAL
     * (Yape/tarjeta), no se suma al efectivo. Copy honesto para no mentir: si querés, dale efectivo
     * extra al conductor en mano; estos chips son la vía digital.
     */
    tipPromptCash:
      'Propina (opcional · 100% al conductor). Por aquí la dejas con Yape o tarjeta; en efectivo, dásela en mano.',
    tipNone: 'Sin propina',
    tipSending: 'Enviando…',
    /** Acciones de cierre. */
    rateTrip: 'Calificar viaje',
    finish: 'Finalizar',

    /**
     * Pago digital PENDING con checkout (ProntoPaga): el usuario DEBE completar el pago (abrir
     * deepLink / pagar en la web / escanear QR / pagar el CIP). El poll del recibo sigue corriendo y,
     * al confirmar el webhook, pasa a CAPTURED solo. Estados honestos, sin data falsa.
     */
    checkout: {
      title: 'Completa tu pago',
      body: 'Tu pago quedó pendiente. Termínalo para cerrar el viaje.',
      /** deepLink → app del wallet. */
      payWithYape: 'Pagar con Yape',
      /** checkoutUrl → web / navegador. */
      payNow: 'Pagar ahora',
      /** qrCode → imagen QR. */
      qrInstruction: 'Escanea este código con tu app Yape o Plin para pagar.',
      qrAccessibility: 'Código QR para completar el pago',
      /** cip → PagoEfectivo. */
      cipLabel: 'Código de pago (CIP)',
      cipInstruction: 'Págalo en tu banco, app bancaria o agente autorizado.',
      cipCopied: 'Código copiado',
      copy: 'Copiar código',
      /** Vencimiento del checkout. */
      expiresAt: 'Vence el {{date}}',
      expiredTitle: 'El código venció',
      expiredBody:
        'Este pago caducó. Reintenta para generar uno nuevo o paga tu viaje en efectivo.',
      /** Hint común mientras esperamos la confirmación. */
      waitingHint: 'Cuando completes el pago, esta pantalla se actualiza sola.',
      /**
       * No se pudo ABRIR Yape automáticamente (openURL rechazó el deepLink). Copy HONESTO: NO culpamos al
       * usuario con "¿la tienes instalada?" (puede tenerla; en sandbox el esquema del deepLink no está
       * registrado). Si hay web de pago, ofrecemos el navegador; si no, "copiar enlace de pago" como salida.
       */
      openYapeFailedTitle: 'No pudimos abrir Yape automáticamente',
      openYapeFailedBody: 'Completa el pago desde el navegador.',
      openYapeFailedBodyNoWeb:
        'Copia el enlace de pago y ábrelo en tu app de Yape.',
      /** Fallback web cuando el deepLink no abre pero hay una urlPay hospedada. */
      payInBrowser: 'Pagar desde el navegador',
      /** Salida cuando el deepLink no abrió y NO hay web: copiar el enlace de pago (Clipboard). */
      copyPayLink: 'Copiar enlace de pago',
      payLinkCopied: 'Enlace copiado',
      /** La web de pago tampoco abrió. */
      openWebFailedTitle: 'No pudimos abrir el navegador',
      openWebFailedBody: 'Inténtalo de nuevo en un momento.',
    },
  },

  /**
   * Gate de DEUDA (BR-P02). Un cobro de un viaje anterior no se pudo completar y quedó en DEBT: la deuda
   * bloquea pedir un viaje nuevo (decisión de producto, gate server-side). La app NO castiga visualmente:
   * tono info/warn sobrio, explica por qué con honestidad y da un camino claro para saldar y volver a pedir.
   */
  debt: {
    /** Título del sheet (al pedir bloqueado o desde la franja del home). */
    title: 'Tienes un pago pendiente',
    /** Línea honesta del porqué (sin culpar, sin tecnicismos). */
    reason: 'Un cobro de un viaje anterior no se pudo completar.',
    /** Antesala del monto grande. */
    amountLabel: 'Pendiente por pagar',
    /** Encabezado de la lista cuando hay más de una deuda. */
    itemsTitle: 'Detalle',
    /** Una fila de la lista compacta de deudas (varias). */
    itemLabel: 'Viaje del {{date}}',
    /** CTA primario: saldar la deuda más antigua. */
    payNow: 'Pagar ahora',
    /** CTA primario en vuelo (esperando la respuesta del re-cobro). */
    paying: 'Procesando…',
    /** Escape SIEMPRE visible: no saldar ahora y cerrar el sheet. */
    notNow: 'Ahora no',
    /** Saldó directo (CAPTURED): éxito + invitación a volver a pedir. */
    settledTitle: '¡Listo!',
    settledBody: 'Ya puedes pedir tu viaje.',
    /** Mismo éxito, pero para un PAGO POR COMPLETAR (no era una deuda que bloqueaba). */
    completedBody: 'Tu pago quedó completo. ¡Gracias!',
    /** Saldó directo desde la franja del home (sin un pedido que reintentar): solo cerrar. */
    settledClose: 'Cerrar',
    /** Encabezado de la rama de checkout dentro del sheet (reusa los medios del recibo). */
    checkoutTitle: 'Termina tu pago',
    checkoutBody: 'Completa el pago para saldar tu deuda y volver a pedir.',
    /** PAGO POR COMPLETAR (PENDING_ACTION): título del sheet y encabezado del checkout directo. */
    continueSheetTitle: 'Tienes un pago por completar',
    continueTitle: 'Completa tu pago',
    continueBody: 'Tu pago quedó pendiente. Termínalo para cerrarlo.',
    /** El pago por completar ya no tiene checkout vivo (capturó o venció): honesto. */
    pendingGoneTitle: 'Este pago ya no está pendiente',
    pendingGoneBody:
      'No hay nada que completar. Si pagaste, ya quedó registrado.',

    /**
     * RESOLVER CON SELECTOR (DEBT en fase idle). Encabezado honesto + selector de método SIEMPRE:
     * el usuario ELIGE con qué saldar (no solo "reintentar el mismo método fallido"). Se pre-destaca
     * su método predeterminado del perfil (si es digital). El CTA primario refleja el método elegido.
     */
    resolveTitle: 'Resuelve el pago de tu viaje',
    /** Subtítulo del selector de resolución: invita a elegir, sin culpar por el cobro fallido. */
    resolveSubtitle:
      'Elige cómo quieres pagarlo. Te sugerimos tu método de siempre.',
    /** CTA primario del selector de resolución, parametrizado con el método elegido. */
    payWith: 'Pagar con {{method}}',
    /** CTA primario en vuelo (esperando la respuesta del cobro con el método elegido). */
    payingWith: 'Procesando con {{method}}…',

    /**
     * MENSAJES HONESTOS POR MÉTODO (resolución de pago). El cobro puede fallar por capacidad del riel
     * (un método no disponible ahora) o por algo transitorio. Distinguimos para no repetir el genérico
     * "no pudimos procesar" en bucle: si el método no anda, invitamos a ELEGIR OTRO; si es transitorio,
     * a reintentar en un momento. Nota de migración: hoy se leen del `reason`/`failureReason` defensivo
     * (ver `resolveFailure` en DebtSheet); cuando `paymentView` exponga `failureReason`/`failureKind`,
     * el mapeo se afina sin tocar el copy.
     */
    methodUnavailableTitle: '{{method}} no está disponible ahora',
    methodUnavailableBody: 'Elige otro método para pagar tu viaje.',
    transientTitle: 'No pudimos completar el cobro',
    transientBody: 'Inténtalo en un momento.',
    /** TODOS los digitales fallaron (el usuario probó y ninguno anduvo): honesto + escape claro, sin bucle. */
    allMethodsFailedTitle: 'Ningún método pudo procesar tu pago',
    allMethodsFailedBody:
      'Vuelve más tarde para resolverlo. No te cobramos nada todavía.',
    tryLater: 'Volver más tarde',

    /**
     * TASK 3 · Cambiar el método de un pago PENDIENTE. Encabezado honesto del pago (monto + método
     * actual) y un CTA secundario que abre el selector de métodos DIGITALES (efectivo NO entra). Al
     * elegir → POST /payments/:id/method → checkout NUEVO + sigue el poll a CAPTURED.
     */
    pendingPaymentLabel: 'Pago de tu viaje',
    /** Línea que muestra el método ACTUAL del pago pendiente (claridad: con qué estás pagando hoy). */
    currentMethod: 'Método actual: {{method}}',
    /** CTA secundario que abre el selector de otro método digital. */
    changeMethodCta: 'Pagar con otro método',
    /** Título del selector de cambio (solo digitales). */
    changeMethodTitle: 'Elige otro método',
    changeMethodSubtitle:
      'Cambias cómo pagar este viaje. El efectivo no aplica aquí.',
    /** En vuelo, mientras el server arma el checkout del método nuevo. */
    changingMethod: 'Cambiando…',
    /** 422: el método elegido no aplica (CASH). Red de seguridad de contrato. */
    changeMethodNotApplicableTitle: 'Ese método no aplica',
    changeMethodNotApplicableBody:
      'Elige Yape, Plin, tarjeta o PagoEfectivo para este pago.',
    /** 409: el pago ya no es cambiable (capturó/venció): honesto, deja cerrar. */
    changeMethodGoneTitle: 'Este pago ya no se puede cambiar',
    changeMethodGoneBody:
      'Cambió de estado mientras tanto. Si ya pagaste, quedó registrado.',
    /** Error genérico de red al cambiar de método. */
    changeMethodError: 'No pudimos cambiar el método. Inténtalo de nuevo.',
    /** El re-cobro falló (el riel rechazó otra vez): estado honesto, deja reintentar. */
    retryFailedTitle: 'No pudimos completar el cobro',
    retryFailedBody:
      'El pago no se pudo procesar. Inténtalo de nuevo en un momento.',
    /** Error genérico de red al saldar. */
    error: 'No pudimos procesar el pago. Inténtalo de nuevo.',
    /** Franja sutil del home (señal pasiva) · DEUDA: monto + acción para resolver (tono warn). */
    homeBannerTitle: 'Tienes un pago pendiente',
    homeBannerAmount: '{{amount}}',
    homeBannerAction: 'Resolver',
    /** Franja sutil del home · PAGO POR COMPLETAR (PENDING_ACTION): sin monto bloqueante, tono info. */
    homePendingTitle: 'Tienes un pago por completar',
    homePendingAction: 'Continuar',
  },

  /** Propinas al conductor (POST /trips/:id/tip). 100% va al conductor. */
  tips: {
    title: '¿Dejar propina?',
    subtitle: 'El 100% de la propina va directo a tu conductor.',
    custom: 'Otro',
    customLabel: 'Monto de la propina (S/)',
    send: 'Enviar propina',
    sending: 'Enviando propina…',
    sentTitle: '¡Propina enviada!',
    sentBody: 'Tu conductor recibió {{amount}}. ¡Gracias por tu generosidad!',
    error: 'No pudimos enviar la propina. Inténtalo de nuevo.',
  },

  /** Recibo del viaje (desglose + compartir nativo). */
  receipt: {
    title: 'Recibo del viaje',
    section: 'Recibo',
    view: 'Ver recibo',
    baseFare: 'Tarifa base',
    surge: 'Demanda alta (x{{multiplier}})',
    tip: 'Propina',
    total: 'Total',
    paymentMethod: 'Método de pago',
    date: 'Fecha',
    driver: 'Conductor',
    vehicle: 'Vehículo',
    route: 'Recorrido',
    distance: 'Distancia',
    duration: 'Duración',
    share: 'Compartir recibo',
    shareTitle: 'Recibo VEO',
    durationMinutes: '{{minutes}} min',
  },

  /** Detalle de un viaje del historial (encabezado de autor). */
  tripDetail: {
    title: 'Detalle del viaje',
    titleDated: 'Viaje del {{date}}',
  },

  ratings: {
    subtitle: '¿Cómo estuvo tu viaje con {{driver}}?',
    /** Estado de calificación INTEGRADO en el detalle. */
    yourRating: 'Tu calificación',
    youRated: 'Calificaste este viaje',
    givenStars: 'Calificaste con {{stars}} de 5 estrellas',
    ctaTitle: 'Califica tu viaje',
    ctaBody: 'Tu calificación ayuda a tu conductor y mejora cada viaje.',
    ctaButton: 'Calificar',
    sheetTitle: 'Califica tu viaje',
    starsLabel: 'Calificación',
    commentLabel: 'Comentario (opcional)',
    commentPlaceholder: 'Cuéntanos cómo te fue…',
    submit: 'Enviar calificación',
    submitting: 'Enviando…',
    thanks: '¡Gracias!',
    /** El viaje ya estaba calificado (409): no es error, mostramos éxito honesto. */
    alreadyRated: 'Ya calificaste este viaje. ¡Gracias!',
    /** Cierre canónico del ciclo (handoff): el botón de salida tras calificar/saltear lee como tal. */
    backHome: 'Volver al inicio',
    error: 'No pudimos enviar tu calificación. Inténtalo de nuevo.',
    selectStars: 'Selecciona al menos una estrella.',
    /** Saltear la calificación: salida clara (no "Omitir" mudo) que igual cierra el viaje y vuelve al home. */
    skip: 'Ahora no',
    /** Chips de motivo condicionados a las estrellas (multi-select). */
    improveLabel: '¿Qué se puede mejorar?',
    praiseLabel: '¿Qué estuvo genial?',
    reason: {
      ROUGH_DRIVING: 'Conducción brusca',
      LATE: 'Llegó tarde',
      DIRTY_VEHICLE: 'Vehículo sucio',
      TREATMENT: 'Trato',
      BAD_ROUTE: 'Ruta no óptima',
      OVERCHARGED: 'Cobró de más',
      GREAT_TREATMENT: 'Excelente trato',
      PUNCTUAL: 'Muy puntual',
      SAFE_DRIVING: 'Conducción segura',
    },
  },

  /** Lugares guardados (Casa, Trabajo, favoritos) — local, sin backend. */
  places: {
    title: 'Lugares guardados',
    subtitle:
      'Guarda tus sitios frecuentes y fíjalos como destino con un toque.',
    home: 'Casa',
    work: 'Trabajo',
    favorites: 'Favoritos',
    quickAccess: 'Lugares guardados',
    setHome: 'Agregar Casa',
    setWork: 'Agregar Trabajo',
    addFavorite: 'Agregar favorito',
    addTitle: 'Nuevo lugar',
    editTitle: 'Editar lugar',
    labelLabel: 'Nombre del lugar',
    labelPlaceholder: 'Ej.: Gimnasio, Casa de mamá',
    pickLabel: 'Dirección',
    pickHelper: 'Busca y elige una dirección para guardarla.',
    pickAction: 'Elegir dirección',
    noAddress: 'Sin dirección seleccionada',
    empty: 'Aún no tienes lugares guardados',
    emptySubtitle: 'Agrega tu Casa, tu Trabajo o tus sitios favoritos.',
    removeTitle: '¿Eliminar lugar?',
    removeBody: 'Dejará de aparecer en tus accesos rápidos.',
    invalidLabel: 'Ingresa un nombre (1 a 40 caracteres).',
    invalidPoint: 'Elige una dirección válida.',
    localNote:
      'Tus lugares se sincronizan con tu cuenta y están disponibles sin conexión.',
    addHomeHint: 'Toca para guardar tu Casa.',
    addWorkHint: 'Toca para guardar tu Trabajo.',
  },

  profile: {
    title: 'Tu cuenta',
    phoneLabel: 'Teléfono',
    nameLabel: 'Nombre',
    nameEmpty: 'Sin nombre registrado',
    namePlaceholder: 'Ej.: María Fernanda Ríos',
    emailLabel: 'Correo',
    emailEmpty: 'Sin correo registrado',
    kycLabel: 'Verificación de identidad',
    /** CABECERA · cuando falta el nombre, el dato faltante ES la invitación (no un misterio). */
    addName: 'Agrega tu nombre',
    /** Botón de edición EXPLÍCITO en la cabecera (ghost, visible — la affordance manda). */
    editProfile: 'Editar perfil',
    editTitle: 'Editar tu perfil',
    /** Microcopy fino junto al nombre cuando la identidad está confirmada (no una pill gritona). */
    identityConfirmed: 'Identidad confirmada',

    /** CALIFICACIÓN RECIBIDA · protagonista de la cabecera (estrella + score). Estado vacío HONESTO:
        sin calificaciones todavía NO se inventa un rating falso ni estrellas en 0. */
    ratingNone: 'Aún sin calificaciones',
    ratingCountOne: '1 viaje',
    ratingCountMany: '{{count}} viajes',

    /** VERIFICACIÓN con voz propia · card de invitación (sin verificar). NADA de "Verificar identidad". */
    verifyCardTitle: 'Confirma que eres tú',
    verifyCardBody: 'Un paso rápido que cuida tus viajes y los de tu familia.',
    verifyCardCta: 'Verificar ahora',

    /** FRANJA DE COMPLETITUD · guía, no castigo. Solo aparece si falta algo; completo = silencio. */
    completionTitle: 'Termina de armar tu perfil',
    completionSubtitle: 'Te falta poco para viajar más tranquilo.',
    completionChipName: 'Tu nombre',
    completionChipPhone: 'Tu celular',
    completionChipDocument: 'Tu documento',

    /** SHEET de celular (altas por correo/Google/Apple sin teléfono). */
    phoneSheetTitle: 'Agrega tu celular',
    phoneSheetIntro:
      'Te mandamos un código por SMS para confirmar que es tuyo.',
    phoneFieldLabel: 'Número de celular',
    phoneFieldPrefix: '+51',
    phoneFieldPlaceholder: '9XX XXX XXX',
    phoneInvalid:
      'Ingresa un celular peruano válido (9 dígitos, empieza con 9).',
    phoneSendCode: 'Enviar código',
    phoneSending: 'Enviando…',
    /** Paso del código (reusa el OtpField del auth). */
    phoneCodeTitle: 'Ingresa el código',
    phoneCodeIntro: 'Te lo enviamos por SMS al {{phone}}.',
    phoneCodeLabel: 'Código de 6 dígitos',
    phoneVerify: 'Confirmar',
    phoneVerifying: 'Confirmando…',
    phoneCodeInvalid: 'Ese código no coincide. Revísalo e inténtalo de nuevo.',
    phoneResend: 'Reenviar código',
    phoneChangeNumber: 'Cambiar número',
    phoneAddedTitle: '¡Listo, celular confirmado!',
    phoneAddedBody: 'Ya puedes recibir avisos de tus viajes por SMS.',
    /** Degradación HONESTA si el backend del celular aún no responde (construcción paralela). */
    phoneUnavailable:
      'Por ahora no pudimos enviar el código. Inténtalo en un ratito.',

    emailPlaceholder: 'tu@correo.com',
    invalidName:
      'Necesitamos tu nombre para que tu conductor sepa a quién recoger (2 a 80 caracteres).',
    invalidEmail: 'Revisa tu correo, parece que le falta algo.',
    /** Documento de identidad en el perfil (habilita la vinculación de Yape de un toque). */
    invalidDocument: 'Revisa tu documento para el tipo que elegiste.',
    documentNote: 'Con esto vinculas tu Yape de un solo toque. Es opcional.',
    docType: {
      DN: 'DNI',
      CE: 'CE',
      PP: 'Pasaporte',
    },
    saved: 'Perfil actualizado',
    saveError: 'No pudimos guardar los cambios.',
    sectionSecurity: 'Seguridad',
    sectionAccount: 'Cuenta',
    // Seguridad
    faceVerification: 'Verificación facial',
    faceVerificationSub: 'Reconocimiento propio, sin terceros',
    verifiedPill: 'Lista',
    trustedContacts: 'Contactos de confianza',
    trustedContactsSub: 'Quiénes ven tus viajes en vivo',
    childMode: 'Modo niño',
    childModeSub: 'Código para cambiar el destino',
    activePill: 'Activo',
    cameraControl: 'Control de cámara',
    cameraControlSub: 'Quién ve tu cámara',
    shareTrip: 'Compartir mi viaje',
    shareTripSub:
      'Durante tu viaje puedes compartirlo con tu familia para que te sigan en tiempo real.',
    // Preferencias
    tripHistory: 'Mis viajes',
    paymentMethods: 'Métodos de pago',
    savedPlaces: 'Lugares guardados',
    referrals: 'Invita y gana',
    // Toggle de notificaciones push (estado real del SO). Tuteo peruano.
    notifications: 'Notificaciones',
    notificationsOn: 'Activadas — te avisamos de tu viaje',
    notificationsOff: 'Actívalas para enterarte de tu viaje',
    notificationsDenied: 'Bloqueadas — actívalas en Ajustes',
    notificationsPill: 'Activadas',
    sectionPreferences: 'Preferencias',
    scheduledTrips: 'Viajes programados',
    // Promociones (opt-in marketing)
    sectionPromotions: 'Promociones',
    promotions: 'Promociones y novedades',
    promotionsSub:
      'Ofertas y avisos de VEO. Puedes desactivarlo cuando quieras.',
    // Cuenta
    accessibility: 'Accesibilidad e idioma',
    help: 'Ayuda',
    logout: 'Cerrar sesión',
    logoutTitle: '¿Cierras sesión?',
    logoutBody: 'Vas a tener que ingresar de nuevo para volver a viajar.',
    deletion: 'Eliminar mi cuenta',
    deletionTitle: 'Derecho al olvido',
    deletionBody:
      'Solicitaremos el borrado de tu cuenta y datos personales (Ley N.° 29733). Hay un periodo de gracia para cancelarlo.',
    requestDeletion: 'Solicitar eliminación',
    deletionRequested: 'Solicitud registrada',
    graceUntil: 'Puedes cancelar la solicitud hasta el {{date}}.',
    // Degradación honesta para items del diseño aún sin pantalla con backend.
    comingSoonTitle: 'Próximamente',
    comingSoonCameraControl:
      'El control de cámara (elegir quién ve tu viaje en vivo) llega en una próxima versión.',
    comingSoonShareTrip:
      'Compartir tu viaje con la familia desde aquí llega en una próxima versión. Durante el viaje ya puedes compartirlo.',
    comingSoonAccessibility:
      'Las opciones de accesibilidad e idioma llegan en una próxima versión.',
  },

  /** Cupones/promociones aplicados a la cotización (POST /promos/validate). */
  promo: {
    cta: '¿Tienes un cupón?',
    title: 'Cupón de descuento',
    label: 'Código del cupón',
    placeholder: 'Ej.: VEO20',
    apply: 'Aplicar',
    applying: 'Validando…',
    remove: 'Quitar cupón',
    appliedTitle: 'Cupón {{code}} aplicado',
    discount: 'Descuento',
    newTotal: 'Nuevo total',
    invalid: 'Este cupón no es válido o no aplica a tu viaje.',
    error: 'No pudimos validar el cupón. Inténtalo de nuevo.',
    emptyCode: 'Ingresa un código de cupón.',
  },

  /** "Invita y gana" — programa de referidos (GET /referrals/me, POST /referrals/redeem). */
  referrals: {
    title: 'Invita y gana',
    subtitle:
      'Comparte tu código. Cuando tu amigo viaje, ambos ganan crédito en VEO.',
    yourCode: 'Tu código',
    copy: 'Copiar',
    copied: '¡Copiado!',
    share: 'Compartir',
    shareMessage:
      'Únete a VEO, la app de viajes más segura del Perú. Usa mi código {{code}} y ambos ganamos crédito. 🚗💚',
    referredCount: 'Amigos referidos',
    rewardsEarned: 'Crédito ganado',
    /** Saldo de crédito GASTABLE (Ola 2A · Lote C). Distinto de `rewardsEarned` (ganado de por vida). */
    availableCredit: 'Crédito disponible',
    creditAutoApply: 'Se aplica solo en tu próximo viaje',
    redeemSection: '¿Te invitó un amigo?',
    redeemLabel: 'Código de tu amigo',
    redeemPlaceholder: 'Ingresa su código',
    redeem: 'Canjear código',
    redeemHint: 'Solo puedes canjear un código una vez.',
    redeemSuccess:
      '¡Código canjeado! Tu crédito se aplicará a tu próximo viaje.',
    redeemError: 'No pudimos canjear el código. Inténtalo de nuevo.',
    codeError: {
      empty: 'Ingresa un código.',
      tooShort: 'El código es demasiado corto.',
      ownCode: 'No puedes canjear tu propio código.',
    },
  },

  /** Chat con el conductor durante el viaje (GET/POST /trips/:id/messages + socket chat:message). */
  chat: {
    title: 'Chat',
    headerSubtitle: 'Conversa con tu conductor',
    open: 'Abrir chat',
    inputPlaceholder: 'Escribe un mensaje…',
    send: 'Enviar mensaje',
    empty: 'Aún no hay mensajes',
    emptySubtitle: 'Escríbele a tu conductor para coordinar el recojo.',
    disabledTitle: 'Chat no disponible',
    disabledBody: 'El chat se habilita mientras tu viaje está activo.',
    loadError: 'No pudimos cargar los mensajes. Inténtalo de nuevo.',
    sendError: 'No se pudo enviar tu mensaje. Inténtalo de nuevo.',
    you: 'Tú',
    driver: 'Conductor',
    quickReplies: 'Respuestas rápidas',
    quick: {
      leaving: 'Ya salgo',
      atDoor: 'Estoy en la puerta',
      onMyWay: 'Voy en camino',
      waiting: 'Te espero aquí',
    },
  },

  /** Centro de Ayuda / Soporte (FAQ estática + tickets: POST/GET /support/tickets). */
  support: {
    faqTitle: 'Preguntas frecuentes',
    faq: {
      requestRide: {
        q: '¿Cómo solicito un viaje?',
        a: 'Desde la pantalla de inicio, ingresa tu destino, elige el tipo de vehículo y confirma. Verás la tarifa estimada antes de pedir; al confirmar, te asignamos el conductor más cercano y puedes seguirlo en el mapa.',
      },
      payment: {
        q: '¿Qué métodos de pago aceptan?',
        a: 'Puedes pagar con Yape, Plin o en efectivo. Elige el método antes de confirmar el viaje; en efectivo, paga directamente al conductor el monto que muestra la app al finalizar.',
      },
      safety: {
        q: '¿Cómo funciona el botón de emergencia?',
        a: 'Durante el viaje puedes activar la alerta de emergencia con la secuencia oculta (pulsa el botón de volumen 3 veces). Avisamos a tus contactos de confianza y a nuestro equipo con tu ubicación en tiempo real. La cámara del habitáculo graba para tu seguridad.',
      },
      privacy: {
        q: '¿Cómo protegen mis datos personales?',
        a: 'Tratamos tus datos según la Ley N.° 29733 de Protección de Datos Personales. Puedes ejercer tus derechos ARCO (acceso, rectificación, cancelación y oposición) y solicitar la eliminación de tu cuenta desde tu perfil.',
      },
      cancellation: {
        q: '¿Puedo cancelar un viaje?',
        a: 'Sí. Puedes cancelar antes de que el conductor llegue. Si cancelas después de que el conductor esté en camino o tras el tiempo de espera, puede aplicarse una penalidad, que verás reflejada antes de confirmar la cancelación.',
      },
    },

    myTicketsTitle: 'Mis solicitudes',
    empty: 'Aún no tienes solicitudes',
    emptySubtitle: 'Cuando reportes un problema, podrás seguir su estado aquí.',

    reportCta: 'Reportar un problema',
    reportTitle: 'Reportar un problema',
    categoryLabel: 'Categoría',
    subjectLabel: 'Asunto',
    subjectPlaceholder: 'Resume tu problema en una frase',
    bodyLabel: 'Mensaje',
    bodyPlaceholder: 'Cuéntanos qué pasó con el mayor detalle posible…',
    attachTrip: 'Adjuntar mi viaje reciente',
    attachTripDetail: 'Viaje del {{date}}',
    attached: 'Adjuntado',
    submit: 'Enviar solicitud',
    sent: 'Solicitud enviada',
    sentBody:
      'Recibimos tu reporte. Te responderemos a la brevedad y podrás seguir su estado en "Mis solicitudes".',
    sendError: 'No pudimos enviar tu solicitud. Inténtalo de nuevo.',
    invalidSubject: 'El asunto debe tener al menos 4 caracteres.',
    invalidBody: 'El mensaje debe tener al menos 10 caracteres.',

    category: {
      TRIP: 'Viaje',
      PAYMENT: 'Pagos',
      ACCOUNT: 'Cuenta',
      SAFETY: 'Seguridad',
      DRIVER: 'Conductor',
      OTHER: 'Otro',
    },
    status: {
      OPEN: 'Abierto',
      IN_PROGRESS: 'En proceso',
      RESOLVED: 'Resuelto',
    },
  },
} as const;

export type CommonResources = typeof common;
