import type {PassengerProfile, YapeAffiliationView} from '@veo/api-client';
import {NavigationContainer} from '@react-navigation/native';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider} from '@veo/ui-kit';
import React from 'react';
import {Linking, Text} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import TestRenderer, {act} from 'react-test-renderer';
import '../../../../i18n';
import {TOKENS} from '../../../../core/di/tokens';
import {container} from '../../../../core/di/registry';
import type {
  CreateYapeAffiliationUseCase,
  GetYapeAffiliationUseCase,
} from '../../domain/affiliationUsecases';
import type {GetProfileUseCase} from '../../../profile/domain/usecases';
import {
  AffiliationDocumentMissingError,
  AffiliationProfileIncompleteError,
  AffiliationUnsupportedError,
  AffiliationUpstreamUnavailableError,
} from '../../domain/affiliationUsecases';

// `useReducedMotion` (ui-kit) usa AccessibilityInfo; el preset de RN no lo implementa. Stub seguros.
{
  const {AccessibilityInfo} = jest.requireActual('react-native');
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockReturnValue({remove: jest.fn()});
}

import {YapeLinkSheet} from './YapeLinkSheet';
import {usePaymentPrefsStore} from '../stores/paymentPrefsStore';

/** Afiliación que vuelve ACTIVE de una (el alta resuelve directo, sin poll): dispara el paso askDefault. */
const ACTIVE_VIEW: YapeAffiliationView = {
  status: 'ACTIVE',
  affiliationId: 'aff_1',
  phoneMasked: '9*****777',
};

const INITIAL_METRICS = {
  frame: {x: 0, y: 0, width: 390, height: 844},
  insets: {top: 47, left: 0, right: 0, bottom: 34},
};

/** Perfil base; los tests sobreescriben `document`/`name` según el caso. */
function makeProfile(overrides: Partial<PassengerProfile>): PassengerProfile {
  return {
    id: 'u1',
    name: 'María Ríos',
    email: null,
    phone: '+51999888777',
    photoUrl: null,
    kycStatus: 'VERIFIED',
    documentType: 'DN',
    document: '12345678',
    ...overrides,
  } as PassengerProfile;
}

const PROCESS_VIEW: YapeAffiliationView = {
  status: 'PROCESS',
  affiliationId: 'aff_1',
  deepLink: 'yape://approve/aff_1',
  phoneMasked: '9*****777',
};

/** Registra dobles de los usecases que el sheet resuelve por DI. */
function registerDeps(opts: {
  profile: PassengerProfile;
  create: jest.Mock;
  affiliation?: YapeAffiliationView;
}): void {
  container.register(
    TOKENS.getProfileUseCase,
    () =>
      ({
        execute: jest.fn().mockResolvedValue(opts.profile),
      }) as unknown as GetProfileUseCase,
  );
  container.register(
    TOKENS.createYapeAffiliationUseCase,
    () => ({execute: opts.create}) as unknown as CreateYapeAffiliationUseCase,
  );
  container.register(
    TOKENS.getYapeAffiliationUseCase,
    () =>
      ({
        execute: jest
          .fn()
          .mockResolvedValue(opts.affiliation ?? {status: 'NONE'}),
      }) as unknown as GetYapeAffiliationUseCase,
  );
}

/** Cliente del test guardado para limpiarlo en `afterEach` (su `gcTime` por defecto deja timers vivos). */
let activeClient: QueryClient | null = null;

function render(node: React.ReactElement): TestRenderer.ReactTestRenderer {
  // `gcTime: 0` + `retry: false`: sin timers de garbage-collection colgados que traben el teardown.
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  activeClient = client;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={INITIAL_METRICS}>
        <QueryClientProvider client={client}>
          <NavigationContainer>
            <ThemeProvider>{node}</ThemeProvider>
          </NavigationContainer>
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  return renderer;
}

/**
 * Deja completar a react-query (queries/mutations) y el re-render resultante. Con timers REALES, react-
 * query agenda en macrotasks: un `setTimeout(0)` real por iteración (no solo microtasks) garantiza que la
 * query del perfil y los `onError`/`onSuccess` de la mutation hayan corrido antes de aserción.
 */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .flatMap(n =>
      Array.isArray(n.props.children) ? n.props.children : [n.props.children],
    )
    .filter((c): c is string => typeof c === 'string');
}

/** ¿Hay un campo de documento (radio "DNI") en pantalla? Distingue modo un-tap vs primera vez. */
function hasDocumentField(renderer: TestRenderer.ReactTestRenderer): boolean {
  return renderer.root
    .findAllByProps({accessibilityRole: 'radio'})
    .some(r => r.props.accessibilityLabel === 'DNI');
}

/** Tap en el botón "Abrir Yape" (o "Abriendo…" si está en curso). El nodo presionable es el que tiene
 *  `onPress`; el rol/label se propaga a hijos host sin handler, así que filtramos por `onPress`. */
async function pressOpenYape(
  renderer: TestRenderer.ReactTestRenderer,
): Promise<void> {
  const btn = renderer.root
    .findAllByProps({accessibilityRole: 'button'})
    .find(b => {
      const label = b.props.accessibilityLabel ?? '';
      return (
        typeof label === 'string' &&
        (label.includes('Abrir Yape') || label.includes('Abriendo')) &&
        typeof b.props.onPress === 'function'
      );
    });
  if (!btn) {
    throw new Error('No se encontró el botón "Abrir Yape"');
  }
  await act(async () => {
    btn.props.onPress();
    await Promise.resolve();
  });
  // Deja settle la mutation (onSuccess/onError) y su re-render.
  await flush();
}

// Timers REALES: react-query no resuelve sus queries bajo fake timers (la query del perfil quedaría
// pendiente y el body no renderiza). El sheet arranca un `setInterval` (poll) y `setTimeout` (cierre,
// reintento del 502); para que esos callbacks NO disparen tras el test y crasheen el entorno RN ya
// desmontado, cada test desmonta el renderer al final (el cleanup del useEffect del poll los limpia).
beforeEach(() => {
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  container.reset();
});

afterEach(() => {
  activeClient?.clear();
  activeClient = null;
  jest.clearAllMocks();
});

/** Espera real (ms) dejando correr timers de verdad (para el reintento del 502 a 1.5s). */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('YapeLinkSheet · flujo de UN TAP', () => {
  it('perfil CON documento → NO muestra campo de documento (cero campos, solo "Abrir Yape")', async () => {
    const create = jest.fn().mockResolvedValue(PROCESS_VIEW);
    registerDeps({profile: makeProfile({document: '12345678'}), create});
    const renderer = render(<YapeLinkSheet visible onClose={() => {}} />);
    await flush();
    expect(hasDocumentField(renderer)).toBe(false);
    expect(texts(renderer)).toContain('Abrir Yape');
    act(() => renderer.unmount());
  });

  it('perfil CON documento → tap "Abrir Yape" llama al usecase SIN argumento (UN TAP)', async () => {
    const create = jest.fn().mockResolvedValue(PROCESS_VIEW);
    registerDeps({
      profile: makeProfile({document: '12345678'}),
      create,
      affiliation: PROCESS_VIEW,
    });
    const renderer = render(<YapeLinkSheet visible onClose={() => {}} />);
    await flush();
    await pressOpenYape(renderer);
    // UN TAP: el sheet invoca el alta sin pasar documento (el server lo resuelve del perfil).
    expect(create).toHaveBeenCalledWith(undefined);
    expect(Linking.openURL).toHaveBeenCalledWith('yape://approve/aff_1');
    // PROCESS → fase waiting (poll): el unmount corre el cleanup del `setInterval` (no queda colgado).
    act(() => renderer.unmount());
  });

  it('perfil SIN documento → revela el campo de documento (primera vez)', async () => {
    const create = jest.fn();
    registerDeps({profile: makeProfile({document: null}), create});
    const renderer = render(<YapeLinkSheet visible onClose={() => {}} />);
    await flush();
    expect(hasDocumentField(renderer)).toBe(true);
    act(() => renderer.unmount());
  });
});

describe('YapeLinkSheet · códigos 422 / 502', () => {
  it('422 PROFILE_DOCUMENT_MISSING en el flujo un-tap → revela el campo de documento', async () => {
    const create = jest
      .fn()
      .mockRejectedValue(new AffiliationDocumentMissingError());
    registerDeps({profile: makeProfile({document: '12345678'}), create});
    const renderer = render(<YapeLinkSheet visible onClose={() => {}} />);
    await flush();
    // Arranca en modo un-tap (sin campo)…
    expect(hasDocumentField(renderer)).toBe(false);
    await pressOpenYape(renderer);
    await flush();
    // …y tras el 422 PROFILE_DOCUMENT_MISSING revela el campo.
    expect(hasDocumentField(renderer)).toBe(true);
    act(() => renderer.unmount());
  });

  it('422 PROFILE_NAME_MISSING → muestra el CTA "Completar perfil" (ir al perfil)', async () => {
    const create = jest
      .fn()
      .mockRejectedValue(new AffiliationProfileIncompleteError());
    registerDeps({profile: makeProfile({document: '12345678'}), create});
    const renderer = render(<YapeLinkSheet visible onClose={() => {}} />);
    await flush();
    await pressOpenYape(renderer);
    await flush();
    expect(texts(renderer)).toContain('Ir a mi perfil');
    act(() => renderer.unmount());
  });

  it('capacidad no habilitada (AffiliationUnsupportedError) → banner INFO honesto y OCULTA "Abrir Yape"', async () => {
    const create = jest
      .fn()
      .mockRejectedValue(new AffiliationUnsupportedError());
    registerDeps({profile: makeProfile({document: '12345678'}), create});
    const renderer = render(<YapeLinkSheet visible onClose={() => {}} />);
    await flush();
    // Antes del intento, el flujo un-tap muestra "Abrir Yape".
    expect(texts(renderer)).toContain('Abrir Yape');
    await pressOpenYape(renderer);
    await flush();
    // Tras la capacidad no habilitada: banner honesto y calmo…
    expect(texts(renderer)).toContain(
      'La vinculación de Yape todavía no está disponible',
    );
    // …y SIN el CTA "Abrir Yape" (no hay nada que abrir; nada de "reintenta").
    expect(texts(renderer)).not.toContain('Abrir Yape');
    expect(texts(renderer).join(' ')).not.toMatch(
      /reint[eé]nta|intent[aá]lo de nuevo/i,
    );
    act(() => renderer.unmount());
  });

  it('502 UPSTREAM_UNAVAILABLE → reintenta automáticamente una vez (1.5s) antes de mostrar error', async () => {
    // Primer intento falla con 502; el reintento automático ya devuelve PROCESS.
    const create = jest
      .fn()
      .mockRejectedValueOnce(new AffiliationUpstreamUnavailableError())
      .mockResolvedValueOnce(PROCESS_VIEW);
    registerDeps({
      profile: makeProfile({document: '12345678'}),
      create,
      affiliation: PROCESS_VIEW,
    });
    const renderer = render(<YapeLinkSheet visible onClose={() => {}} />);
    await flush();
    await pressOpenYape(renderer);
    // Tras el primer fallo, el sheet NO muestra el error: programó el reintento (1.5s).
    expect(create).toHaveBeenCalledTimes(1);
    expect(texts(renderer)).not.toContain(
      'El servicio de Yape está ocupado. Inténtalo en un momento.',
    );
    // Dejamos pasar el respiro real del reintento automático.
    await act(async () => {
      await wait(1700);
    });
    await flush();
    // El reintento automático se disparó (2 llamadas en total).
    expect(create).toHaveBeenCalledTimes(2);
    // El reintento entró en fase `waiting` (PROCESS): el unmount limpia el `setInterval` del poll.
    act(() => renderer.unmount());
  });
});

describe('YapeLinkSheet · TASK 1 · ACTIVE PREGUNTA, no auto-setea el predeterminado', () => {
  beforeEach(() => {
    // Arranca cada caso con el predeterminado en CASH para detectar si setDefault('YAPE') se llamó o no.
    usePaymentPrefsStore.getState().setDefault('CASH');
  });

  it('al quedar ACTIVE muestra el paso "¿usar Yape como predeterminado?" SIN tocar el predeterminado', async () => {
    const create = jest.fn().mockResolvedValue(ACTIVE_VIEW);
    registerDeps({
      profile: makeProfile({document: '12345678'}),
      create,
      affiliation: ACTIVE_VIEW,
    });
    const renderer = render(<YapeLinkSheet visible onClose={() => {}} />);
    await flush();
    await pressOpenYape(renderer);

    // Pregunta (no setea solo): el paso askDefault con sus dos opciones.
    const out = texts(renderer);
    expect(out).toContain('Yape quedó vinculado');
    expect(out).toContain('Sí, usar Yape');
    expect(out).toContain('Ahora no');
    // Y el predeterminado NO se tocó todavía (sigue en CASH): nada silencioso.
    expect(usePaymentPrefsStore.getState().defaultMethod).toBe('CASH');
    act(() => renderer.unmount());
  });

  it('"Sí, usar Yape" → recién ahí el predeterminado pasa a YAPE', async () => {
    const create = jest.fn().mockResolvedValue(ACTIVE_VIEW);
    registerDeps({
      profile: makeProfile({document: '12345678'}),
      create,
      affiliation: ACTIVE_VIEW,
    });
    const renderer = render(<YapeLinkSheet visible onClose={() => {}} />);
    await flush();
    await pressOpenYape(renderer);

    const yes = renderer.root
      .findAllByProps({accessibilityRole: 'button'})
      .find(
        b =>
          typeof b.props.accessibilityLabel === 'string' &&
          b.props.accessibilityLabel.includes('Sí, usar Yape') &&
          typeof b.props.onPress === 'function',
      );
    await act(async () => {
      yes?.props.onPress();
      await Promise.resolve();
    });
    expect(usePaymentPrefsStore.getState().defaultMethod).toBe('YAPE');
    act(() => renderer.unmount());
  });

  it('"Ahora no" → el predeterminado NO cambia (queda como estaba)', async () => {
    const create = jest.fn().mockResolvedValue(ACTIVE_VIEW);
    registerDeps({
      profile: makeProfile({document: '12345678'}),
      create,
      affiliation: ACTIVE_VIEW,
    });
    const renderer = render(<YapeLinkSheet visible onClose={() => {}} />);
    await flush();
    await pressOpenYape(renderer);

    const no = renderer.root
      .findAllByProps({accessibilityRole: 'button'})
      .find(
        b =>
          typeof b.props.accessibilityLabel === 'string' &&
          b.props.accessibilityLabel.includes('Ahora no') &&
          typeof b.props.onPress === 'function',
      );
    await act(async () => {
      no?.props.onPress();
      await Promise.resolve();
    });
    expect(usePaymentPrefsStore.getState().defaultMethod).toBe('CASH');
    act(() => renderer.unmount());
  });
});
