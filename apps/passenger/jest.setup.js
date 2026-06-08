/* eslint-disable */
// Setup global de Jest para React Native.

// Gesture Handler: mocks necesarios para que los componentes rendericen en tests.
require('react-native-gesture-handler/jestSetup');

// Reanimated: mock oficial + silenciar el warning de la capa nativa.
jest.mock('react-native-reanimated', () =>
  require('react-native-reanimated/mock'),
);

// react-native-config: sin capa nativa en Jest. Devolvemos vacío para que `env`
// caiga en sus defaults validados por zod.
jest.mock('react-native-config', () => ({ __esModule: true, default: {} }));

// @rnmapbox/maps: el SDK nativo de Mapbox no está disponible en Jest. Mockeamos los componentes
// usados por `AppMap` como passthrough (renderizan vistas vacías) y `setAccessToken` como no-op,
// para que las pantallas con mapa se monten en tests sin cargar el módulo nativo ni GL.
jest.mock('@rnmapbox/maps', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Passthrough = ({ children }) => React.createElement(View, null, children);
  return {
    __esModule: true,
    default: {
      setAccessToken: jest.fn(),
      StyleURL: { Street: 'mapbox://styles/mapbox/streets-v12' },
    },
    MapView: Passthrough,
    Camera: Passthrough,
    ShapeSource: Passthrough,
    LineLayer: Passthrough,
    CircleLayer: Passthrough,
    MarkerView: Passthrough,
    UserLocation: Passthrough,
    PointAnnotation: Passthrough,
  };
});

// react-native-background-geolocation: sin capa nativa en Jest. Mock mínimo con las
// constantes/métodos usados por el LocationProvider (los tests no ejecutan GPS real).
jest.mock('react-native-background-geolocation', () => ({
  __esModule: true,
  default: {
    DESIRED_ACCURACY_HIGH: -1,
    PERSIST_MODE_NONE: 0,
    ready: jest.fn(() => Promise.resolve({})),
    getCurrentPosition: jest.fn(() =>
      Promise.resolve({ coords: { latitude: 0, longitude: 0 } }),
    ),
    onLocation: jest.fn(() => ({ remove: jest.fn() })),
    start: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
  },
}));

// react-native-keychain: sin capa nativa en Jest. Mock con las funciones/enums usados.
jest.mock('react-native-keychain', () => ({
  __esModule: true,
  getGenericPassword: jest.fn(() => Promise.resolve(false)),
  setGenericPassword: jest.fn(() => Promise.resolve({ service: 'test' })),
  hasGenericPassword: jest.fn(() => Promise.resolve(false)),
  resetGenericPassword: jest.fn(() => Promise.resolve(true)),
  getSupportedBiometryType: jest.fn(() => Promise.resolve(null)),
  ACCESSIBLE: { AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock', WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly' },
  ACCESS_CONTROL: { BIOMETRY_ANY: 'BiometryAny' },
  STORAGE_TYPE: { AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth', AES_GCM: 'KeystoreAESGCM' },
}));

// Google Sign-In: sin capa nativa en Jest. Mock con la superficie usada por `useOAuthFlow`
// (configure/signIn/hasPlayServices + helpers de respuesta y statusCodes).
jest.mock('@react-native-google-signin/google-signin', () => ({
  __esModule: true,
  GoogleSignin: {
    configure: jest.fn(),
    hasPlayServices: jest.fn(() => Promise.resolve(true)),
    signIn: jest.fn(() =>
      Promise.resolve({ type: 'success', data: { idToken: 'google.id.token' } }),
    ),
  },
  isSuccessResponse: (r) => r && r.type === 'success',
  isErrorWithCode: (e) => Boolean(e && typeof e.code === 'string'),
  statusCodes: {
    SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
    IN_PROGRESS: 'IN_PROGRESS',
    PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
    SIGN_IN_REQUIRED: 'SIGN_IN_REQUIRED',
  },
}));

// Sign in with Apple: sin capa nativa en Jest. Mock con appleAuth + AppleButton (vista vacía).
jest.mock('@invertase/react-native-apple-authentication', () => {
  const React = require('react');
  const { View } = require('react-native');
  const AppleButton = ({ children }) => React.createElement(View, null, children);
  AppleButton.Type = { DEFAULT: 'SignIn', SIGN_IN: 'SignIn', CONTINUE: 'Continue', SIGN_UP: 'SignUp' };
  AppleButton.Style = { DEFAULT: 'White', WHITE: 'White', WHITE_OUTLINE: 'WhiteOutline', BLACK: 'Black' };
  return {
    __esModule: true,
    AppleButton,
    appleAuth: {
      isSupported: true,
      performRequest: jest.fn(() => Promise.resolve({ identityToken: 'apple.identity.token' })),
      Operation: { LOGOUT: 0, LOGIN: 1, REFRESH: 2, IMPLICIT: 3 },
      Scope: { EMAIL: 0, FULL_NAME: 1 },
      Error: { UNKNOWN: '1000', CANCELED: '1001', INVALID_RESPONSE: '1002', NOT_HANDLED: '1003', FAILED: '1004' },
    },
  };
});

// MMKV: implementación en memoria para tests (no hay capa nativa en Jest).
jest.mock('react-native-mmkv', () => {
  const store = new Map();
  class MMKV {
    set(key, value) {
      store.set(key, value);
    }
    getString(key) {
      const v = store.get(key);
      return typeof v === 'string' ? v : undefined;
    }
    getNumber(key) {
      const v = store.get(key);
      return typeof v === 'number' ? v : undefined;
    }
    getBoolean(key) {
      const v = store.get(key);
      return typeof v === 'boolean' ? v : undefined;
    }
    contains(key) {
      return store.has(key);
    }
    delete(key) {
      store.delete(key);
    }
    clearAll() {
      store.clear();
    }
  }
  return { MMKV };
});
