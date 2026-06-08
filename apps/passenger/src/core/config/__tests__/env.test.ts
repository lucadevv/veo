/**
 * Cobertura del auto-host derivado de Metro (`metroDevHost`) y de la precedencia de
 * resolución de URLs del backend en dev (Config .env > metro-derived > localhost/10.0.2.2).
 *
 * `env.ts` ejecuta su lógica al importarse (defaults evaluados top-level), por eso cada
 * escenario usa `jest.isolateModules` + `jest.doMock` para controlar `scriptURL` y `Config`
 * ANTES de re-importar el módulo.
 */

type EnvModule = typeof import('../env');

/** Acceso tipado a la global `__DEV__` que inyecta React Native en runtime. */
const devGlobal = globalThis as typeof globalThis & { __DEV__?: boolean };

type SourceCodeHolder = { SourceCode?: { scriptURL?: unknown } };

/** Setea `NativeModules.SourceCode.scriptURL` en una instancia de react-native. */
function setScriptURL(rn: typeof import('react-native'), scriptURL: unknown): void {
  (rn.NativeModules as SourceCodeHolder).SourceCode = { scriptURL };
}

/**
 * Re-importa `env.ts` con un `scriptURL` y un `Config` controlados.
 * `isolateModules` aísla el registro de módulos por escenario para re-evaluar la
 * lógica top-level de `env.ts`. Bajo el preset CJS de jest el re-import dinámico es
 * `require()` (no hay VM modules); por eso este archivo de test habilita
 * `no-require-imports` en el override de tests de `eslint.config.mjs`.
 *
 * Ojo: `metroDevHost()` es lazy (lee `NativeModules` al llamarse), y se invoca FUERA
 * del callback de `isolateModules` (en los `expect`). Al salir del isolate, jest
 * restaura el registro original; por eso seteamos el `scriptURL` en AMBAS instancias
 * (la aislada para los defaults top-level, y la externa restaurada para la llamada
 * diferida de `metroDevHost()`).
 */
function loadEnv(opts: {
  scriptURL?: unknown;
  config?: Record<string, string | undefined>;
  dev?: boolean;
}): EnvModule {
  const prevDev = devGlobal.__DEV__;
  devGlobal.__DEV__ = opts.dev ?? true;

  // Instancia externa (registro restaurado tras el isolate): la lee `metroDevHost()` lazy.
  setScriptURL(require('react-native') as typeof import('react-native'), opts.scriptURL);

  let mod!: EnvModule;
  jest.isolateModules(() => {
    jest.doMock('react-native-config', () => ({
      __esModule: true,
      default: opts.config ?? {},
    }));

    // Instancia aislada: la leen los defaults top-level de `env.ts` al importarse
    // (sin spread del módulo entero: eso fuerza getters perezosos que explotan en jest).
    setScriptURL(require('react-native') as typeof import('react-native'), opts.scriptURL);

    mod = require('../env') as EnvModule;
  });

  devGlobal.__DEV__ = prevDev;
  return mod;
}

describe('metroDevHost', () => {
  it('parsea el host de un scriptURL http de Metro (device físico)', () => {
    const { metroDevHost } = loadEnv({
      scriptURL: 'http://192.168.18.227:8081/index.bundle?platform=ios&dev=true',
    });
    expect(metroDevHost()).toBe('192.168.18.227');
  });

  it('parsea hostname (no IP) y soporta https', () => {
    const { metroDevHost } = loadEnv({
      scriptURL: 'https://my-mac.local:8081/index.bundle?platform=android',
    });
    expect(metroDevHost()).toBe('my-mac.local');
  });

  it('devuelve null para un scriptURL file:// (release, sin host)', () => {
    const { metroDevHost } = loadEnv({
      scriptURL: 'file:///var/containers/Bundle/Application/main.jsbundle',
    });
    expect(metroDevHost()).toBeNull();
  });

  it('devuelve null para basura / scriptURL ausente', () => {
    expect(loadEnv({ scriptURL: 'no-soy-una-url' }).metroDevHost()).toBeNull();
    expect(loadEnv({ scriptURL: undefined }).metroDevHost()).toBeNull();
    expect(loadEnv({ scriptURL: '' }).metroDevHost()).toBeNull();
    expect(loadEnv({ scriptURL: 123 }).metroDevHost()).toBeNull();
  });
});

describe('env · precedencia de resolución (dev)', () => {
  it('metro-derived: sin override, deriva las URLs del host de Metro', () => {
    const { env } = loadEnv({
      scriptURL: 'http://192.168.18.227:8081/index.bundle?platform=ios',
      config: {},
    });
    expect(env.publicBffUrl).toBe('http://192.168.18.227:4001/api/v1');
    expect(env.publicBffWsUrl).toBe('http://192.168.18.227:4001');
    expect(env.mapStyleUrl).toBe(
      'http://192.168.18.227:8082/styles/veo-dark/style.json',
    );
  });

  it('Config (.env) GANA al metro-derived: staging/prod no se ven afectados', () => {
    const { env } = loadEnv({
      // Aunque haya host de Metro, el override explícito del .env tiene prioridad.
      scriptURL: 'http://192.168.18.227:8081/index.bundle?platform=ios',
      config: {
        PUBLIC_BFF_URL: 'https://api.veo.pe/passenger/api/v1',
        PUBLIC_BFF_WS_URL: 'https://api.veo.pe',
        PUBLIC_MAP_STYLE_URL: 'https://tiles.veo.pe/styles/veo-dark/style.json',
      },
    });
    expect(env.publicBffUrl).toBe('https://api.veo.pe/passenger/api/v1');
    expect(env.publicBffWsUrl).toBe('https://api.veo.pe');
    expect(env.mapStyleUrl).toBe(
      'https://tiles.veo.pe/styles/veo-dark/style.json',
    );
  });

  it('fallback: sin host de Metro y sin override → localhost', () => {
    const { env } = loadEnv({
      scriptURL: 'file:///main.jsbundle',
      config: {},
    });
    expect(env.publicBffUrl).toBe('http://localhost:4001/api/v1');
    expect(env.publicBffWsUrl).toBe('http://localhost:4001');
  });
});
