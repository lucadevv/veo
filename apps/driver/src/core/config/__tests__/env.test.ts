/**
 * Cobertura de la resolución de URLs del driver-bff (:4002): defaults, auto-derive del host de Metro
 * (`metroDevHost`, vía getDevServer en new-arch + scriptURL en arq vieja) y auto-sanado de overrides
 * stale en dev (IP LAN rotada, dominio bakeado de túnel muerto) con escape `DEV_FORCE_ENV_URLS`.
 * Mismo patrón que la passenger app. `env.ts` ejecuta su lógica al importarse, por eso cada escenario
 * usa `jest.isolateModules` + `jest.doMock` para controlar `Config`/`scriptURL` antes de re-importar.
 */
type EnvModule = typeof import('../env');

const devGlobal = globalThis as typeof globalThis & { __DEV__?: boolean };

type SourceCodeHolder = { SourceCode?: { scriptURL?: unknown } };

function setScriptURL(rn: typeof import('react-native'), scriptURL: unknown): void {
  (rn.NativeModules as SourceCodeHolder).SourceCode = { scriptURL };
}

/**
 * URL del mock de `getDevServer()` (fuente preferida en new-arch). `null` ⇒ getDevServer "no
 * disponible" (lanza) → `metroDevHost` cae a `scriptURL` (= arquitectura vieja). El prefijo `mock`
 * lo exige el babel-plugin de jest para referenciarla dentro del factory hoisteado.
 */
let mockDevServerUrl: string | null = null;
jest.mock(
  'react-native/Libraries/Core/Devtools/getDevServer',
  () => ({
    __esModule: true,
    default: () => {
      if (mockDevServerUrl == null) {
        throw new Error('getDevServer no disponible (test: arquitectura vieja)');
      }
      return { url: mockDevServerUrl, bundleLoadedFromServer: true };
    },
  }),
  { virtual: true },
);

function loadEnv(opts: {
  scriptURL?: unknown;
  /** URL del packager vía getDevServer (new-arch). Omitido ⇒ getDevServer lanza → fallback a scriptURL. */
  devServerUrl?: string | null;
  config?: Record<string, string | undefined>;
  dev?: boolean;
}): EnvModule {
  const prevDev = devGlobal.__DEV__;
  devGlobal.__DEV__ = opts.dev ?? true;
  mockDevServerUrl = opts.devServerUrl ?? null;

  // Instancia externa (registro restaurado tras el isolate): la lee `metroDevHost()` lazy.
  setScriptURL(require('react-native') as typeof import('react-native'), opts.scriptURL);

  let mod!: EnvModule;
  jest.isolateModules(() => {
    jest.doMock('react-native-config', () => ({
      __esModule: true,
      default: opts.config ?? {},
    }));
    setScriptURL(require('react-native') as typeof import('react-native'), opts.scriptURL);
    mod = require('../env') as EnvModule;
  });

  devGlobal.__DEV__ = prevDev;
  return mod;
}

describe('metroDevHost (driver)', () => {
  it('new-arch: deriva el host de getDevServer cuando scriptURL es null (bridgeless)', () => {
    const { metroDevHost } = loadEnv({
      scriptURL: null,
      devServerUrl: 'http://localhost:8081/',
    });
    expect(metroDevHost()).toBe('localhost');
  });

  it('device físico new-arch: getDevServer trae la IP de la Mac', () => {
    const { metroDevHost } = loadEnv({
      scriptURL: null,
      devServerUrl: 'http://192.168.18.238:8081/',
    });
    expect(metroDevHost()).toBe('192.168.18.238');
  });

  it('arq vieja: cae a scriptURL si getDevServer no está', () => {
    const { metroDevHost } = loadEnv({
      scriptURL: 'http://192.168.18.238:8081/index.bundle?platform=android',
    });
    expect(metroDevHost()).toBe('192.168.18.238');
  });

  it('release / sin packager → null', () => {
    expect(loadEnv({ scriptURL: 'file:///main.jsbundle' }).metroDevHost()).toBeNull();
    expect(loadEnv({ scriptURL: undefined }).metroDevHost()).toBeNull();
  });
});

describe('env (driver) · resolución de URLs', () => {
  it('defaults válidos cuando Config está vacío y no hay Metro host (iOS → localhost:4002)', () => {
    const { env } = loadEnv({ scriptURL: undefined, config: {} });
    expect(env.DRIVER_BFF_URL).toBe('http://localhost:4002/api/v1');
    expect(env.DRIVER_BFF_URL).toMatch(/\/api\/v1$/);
    expect(env.DRIVER_BFF_WS_URL).toBe('http://localhost:4002');
    expect(env.DRIVER_BFF_WS_URL).not.toMatch(/\/api\/v1$/);
    expect(() => new URL(env.DRIVER_BFF_URL)).not.toThrow();
  });

  it('metro-derived: sin override, deriva del host de Metro (:4002)', () => {
    const { env } = loadEnv({
      scriptURL: null,
      devServerUrl: 'http://192.168.18.238:8081/',
      config: {},
    });
    expect(env.DRIVER_BFF_URL).toBe('http://192.168.18.238:4002/api/v1');
    expect(env.DRIVER_BFF_WS_URL).toBe('http://192.168.18.238:4002');
  });

  it('REGRESIÓN dominio bakeado (túnel muerto): con Metro vivo, el dominio del .env se ignora', () => {
    // El bug real (2026-07-03): el build nativo quedó con el dominio del túnel Cloudflare muerto
    // bakeado por react-native-config y NI UN request llegaba al driver-bff local.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { env } = loadEnv({
      scriptURL: null,
      devServerUrl: 'http://192.168.18.238:8081/',
      config: {
        DRIVER_BFF_URL: 'https://driver-dev.yoveoapp.com/api/v1',
        DRIVER_BFF_WS_URL: 'https://driver-dev.yoveoapp.com',
      },
    });
    expect(env.DRIVER_BFF_URL).toBe('http://192.168.18.238:4002/api/v1');
    expect(env.DRIVER_BFF_WS_URL).toBe('http://192.168.18.238:4002');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('DEV_FORCE_ENV_URLS=true: el override (dominio/IP fija) se honra tal cual en dev', () => {
    const { env } = loadEnv({
      scriptURL: null,
      devServerUrl: 'http://192.168.18.238:8081/',
      config: {
        DEV_FORCE_ENV_URLS: 'true',
        DRIVER_BFF_URL: 'https://api.veo.pe/driver/api/v1',
        DRIVER_BFF_WS_URL: 'https://api.veo.pe',
      },
    });
    expect(env.DRIVER_BFF_URL).toBe('https://api.veo.pe/driver/api/v1');
    expect(env.DRIVER_BFF_WS_URL).toBe('https://api.veo.pe');
  });

  it('override con el MISMO host que Metro (puerto/path custom) → se respeta tal cual', () => {
    const { env } = loadEnv({
      scriptURL: null,
      devServerUrl: 'http://192.168.18.238:8081/',
      config: { DRIVER_BFF_URL: 'http://192.168.18.238:9999/custom/api' },
    });
    expect(env.DRIVER_BFF_URL).toBe('http://192.168.18.238:9999/custom/api');
  });

  it('REGRESIÓN new-arch (el bug): scriptURL=null + getDevServer + .env IP LAN stale → host de Metro', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { env } = loadEnv({
      scriptURL: null,
      devServerUrl: 'http://192.168.18.238:8081/',
      config: { DRIVER_BFF_URL: 'http://192.168.18.227:4002/api/v1' },
    });
    expect(env.DRIVER_BFF_URL).toBe('http://192.168.18.238:4002/api/v1');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('release (!__DEV__): NUNCA se auto-sana — el override del .env manda', () => {
    const { env } = loadEnv({
      dev: false,
      scriptURL: null,
      devServerUrl: 'http://192.168.18.238:8081/',
      config: { DRIVER_BFF_URL: 'http://192.168.18.227:4002/api/v1' },
    });
    expect(env.DRIVER_BFF_URL).toBe('http://192.168.18.227:4002/api/v1');
  });
});
