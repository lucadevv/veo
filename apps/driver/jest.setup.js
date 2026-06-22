/* eslint-env jest */

// Gesture Handler necesita su setup en el entorno de pruebas.
require('react-native-gesture-handler/jestSetup');

// Reanimated trae un mock oficial para Jest.
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

// MMKV: storage nativo no disponible en Jest. v4 expone la factory `createMMKV(config)` (además del
// type `MMKV`); el código usa la factory, así que el mock DEBE proveerla, no solo la clase.
jest.mock('react-native-mmkv', () => {
  const instance = () => ({
    set: jest.fn(),
    getString: jest.fn(),
    getNumber: jest.fn(),
    getBoolean: jest.fn(),
    // v4 renombró `delete` → `remove`; mantenemos ambos por compat con cualquier consumidor.
    remove: jest.fn(),
    delete: jest.fn(),
    clearAll: jest.fn(),
  });
  return {
    createMMKV: jest.fn(instance),
    MMKV: jest.fn().mockImplementation(instance),
  };
});

// react-native-config: variables de entorno nativas.
jest.mock('react-native-config', () => ({}));

// @rnmapbox/maps: el SDK nativo de Mapbox no está disponible en Jest. Mockeamos los componentes
// como pasthrough (renderizan sus children) y `setAccessToken` como no-op para que cualquier test
// que monte AppMap no intente cargar el módulo nativo.
jest.mock('@rnmapbox/maps', () => {
  const React = require('react');
  const passthrough = ({ children }) => React.createElement(React.Fragment, null, children);
  return {
    __esModule: true,
    default: {
      setAccessToken: jest.fn(),
      StyleURL: { Street: 'mapbox://styles/mapbox/streets-v12' },
    },
    MapView: passthrough,
    Camera: passthrough,
    ShapeSource: passthrough,
    LineLayer: passthrough,
    CircleLayer: passthrough,
    MarkerView: passthrough,
  };
});

// react-native-image-picker: el SDK se distribuye como ESM y arrastra el módulo nativo de cámara,
// que no existe en Jest. Lo importa transitivamente el contenedor de DI (picker de documentos), así
// que cualquier test que toque el contenedor lo necesita mockeado. `launchCamera`/`launchImageLibrary`
// devuelven "cancelado" por defecto; los tests que ejercitan la captura lo sobre-mockean.
jest.mock('react-native-image-picker', () => ({
  launchCamera: jest.fn().mockResolvedValue({ didCancel: true }),
  launchImageLibrary: jest.fn().mockResolvedValue({ didCancel: true }),
}));

// VeoDocumentScanner: el escáner de documentos nativo (iOS VisionKit / Android MLKit) no existe en
// Jest. Lo registramos en `NativeModules` (asignación directa, sin tocar el grafo del módulo) para
// que el servicio (`native-document-scanner`) lo encuentre enlazado por defecto; `scan` rechaza con
// `E_CANCELLED` (cancelado), igual que el picker defaultea a "cancelado". Los tests que ejercitan el
// escaneo sobre-mockean `NativeModules.VeoDocumentScanner`.
{
  const { NativeModules } = require('react-native');
  NativeModules.VeoDocumentScanner = {
    scan: jest.fn().mockRejectedValue({ code: 'E_CANCELLED', message: 'cancelled' }),
  };
}

// @react-native-community/datetimepicker: el picker nativo de fecha no existe en Jest. El default
// export es el componente (iOS) y `DateTimePickerAndroid.open` la API imperativa (Android). Mockeamos
// el componente como passthrough (no renderiza nada) y `open`/`dismiss` como no-ops; los tests que
// ejercitan la confirmación de fecha invocan los callbacks directamente (lógica ISO ↔ Date, no nativa).
jest.mock('@react-native-community/datetimepicker', () => {
  const noop = () => null;
  return {
    __esModule: true,
    default: noop,
    DateTimePickerAndroid: {
      open: jest.fn(),
      dismiss: jest.fn().mockResolvedValue(true),
    },
  };
});

// BiometricCameraPreview: la vista nativa de cámara (`requireNativeComponent('BiometricCameraPreview')`)
// no existe en Jest. El preset de RN ya auto-mockea `requireNativeComponent` (devuelve un host stub),
// pero mockeamos el wrapper explícitamente para que la pantalla del KYC renderice predecible y para que
// los tests puedan disparar `onCameraReady`/`onCameraError`. Es un passthrough que NO abre cámara.
jest.mock(
  './src/features/registration/presentation/components/BiometricCameraPreview',
  () => {
    const React = require('react');
    const { View } = require('react-native');
    const BiometricCameraPreview = (props) =>
      React.createElement(View, { ...props, testID: 'biometric-camera-preview' });
    return {
      __esModule: true,
      default: BiometricCameraPreview,
      BIOMETRIC_CAMERA_PREVIEW_NAME: 'BiometricCameraPreview',
    };
  },
);

// Lote 2: el liveness DIY (vision-camera v5 + face-detector + Nitro) se retiró. El KYC del alta usa una
// SELFIE simple sobre la vista nativa `BiometricCameraPreview` (mockeada arriba) + el módulo nativo
// `VeoBiometricFrameGrabber.capturePhoto()`. Ya nadie en `src` importa vision-camera/face-detector/nitro,
// así que sus mocks (y sus entradas en transformIgnorePatterns) se eliminaron.

// react-native-keychain: almacén seguro nativo no disponible en Jest.
jest.mock('react-native-keychain', () => ({
  getSupportedBiometryType: jest.fn().mockResolvedValue(null),
  setGenericPassword: jest.fn().mockResolvedValue(false),
  getGenericPassword: jest.fn().mockResolvedValue(false),
  hasGenericPassword: jest.fn().mockResolvedValue(false),
  resetGenericPassword: jest.fn().mockResolvedValue(true),
  ACCESS_CONTROL: { BIOMETRY_CURRENT_SET: 'BiometryCurrentSet' },
  ACCESSIBLE: { WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'AccessibleWhenPasscodeSetThisDeviceOnly' },
}));
