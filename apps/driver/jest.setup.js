/* eslint-env jest */

// Gesture Handler necesita su setup en el entorno de pruebas.
require('react-native-gesture-handler/jestSetup');

// Reanimated trae un mock oficial para Jest.
jest.mock('react-native-reanimated', () =>
  require('react-native-reanimated/mock'),
);

// MMKV: storage nativo no disponible en Jest.
jest.mock('react-native-mmkv', () => ({
  MMKV: jest.fn().mockImplementation(() => ({
    set: jest.fn(),
    getString: jest.fn(),
    getNumber: jest.fn(),
    getBoolean: jest.fn(),
    delete: jest.fn(),
    clearAll: jest.fn(),
  })),
}));

// react-native-config: variables de entorno nativas.
jest.mock('react-native-config', () => ({}));

// @rnmapbox/maps: el SDK nativo de Mapbox no está disponible en Jest. Mockeamos los componentes
// como pasthrough (renderizan sus children) y `setAccessToken` como no-op para que cualquier test
// que monte AppMap no intente cargar el módulo nativo.
jest.mock('@rnmapbox/maps', () => {
  const React = require('react');
  const passthrough = ({children}) => React.createElement(React.Fragment, null, children);
  return {
    __esModule: true,
    default: {setAccessToken: jest.fn(), StyleURL: {Street: 'mapbox://styles/mapbox/streets-v12'}},
    MapView: passthrough,
    Camera: passthrough,
    ShapeSource: passthrough,
    LineLayer: passthrough,
    CircleLayer: passthrough,
    MarkerView: passthrough,
  };
});

// react-native-keychain: almacén seguro nativo no disponible en Jest.
jest.mock('react-native-keychain', () => ({
  getSupportedBiometryType: jest.fn().mockResolvedValue(null),
  setGenericPassword: jest.fn().mockResolvedValue(false),
  getGenericPassword: jest.fn().mockResolvedValue(false),
  hasGenericPassword: jest.fn().mockResolvedValue(false),
  resetGenericPassword: jest.fn().mockResolvedValue(true),
  ACCESS_CONTROL: {BIOMETRY_CURRENT_SET: 'BiometryCurrentSet'},
  ACCESSIBLE: {WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'AccessibleWhenPasscodeSetThisDeviceOnly'},
}));

// Silenciar el warning de animaciones nativas en pruebas.
jest.mock('react-native/Libraries/Animated/NativeAnimatedHelper');
