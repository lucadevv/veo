module.exports = {
  preset: '@react-native/jest-preset',
  // Reanimated 4 delega en react-native-worklets; su mock oficial ya NO alcanza solo: el resolver
  // OFICIAL de worklets hace que Jest cargue la implementación JS (no la `.native`, que exige el
  // TurboModule). Sin esto, CUALQUIER test que importe @veo/ui-kit (Button → usePressScale →
  // reanimated) revienta con "Cannot read properties of undefined (reading 'loadUnpackers')".
  resolver: 'react-native-worklets/jest/resolver.js',
  setupFiles: ['./jest.setup.js'],
  // Permite ejecutar la suite aunque todavía no existan tests (scaffold).
  passWithNoTests: true,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // Transformar los módulos RN y los packages compartidos @veo/* (TS sin compilar).
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-.*|@veo/.*)/)',
  ],
};
