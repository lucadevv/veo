module.exports = {
  preset: '@react-native/jest-preset',
  // Reanimated 4 delega en react-native-worklets; su mock oficial ya NO alcanza solo: el resolver
  // OFICIAL de worklets hace que Jest cargue la implementación JS (no la `.native`, que exige el
  // TurboModule). Sin esto, CUALQUIER test que importe @veo/ui-kit (Button → usePressScale →
  // reanimated) revienta con "Cannot read properties of undefined (reading 'loadUnpackers')".
  // Mismo fix que apps/passenger/jest.config.js.
  resolver: 'react-native-worklets/jest/resolver.js',
  setupFiles: ['./jest.setup.js'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transformIgnorePatterns: [
    'node_modules/(?!(' +
      '@react-native' +
      '|react-native' +
      '|@react-navigation' +
      '|react-native-gesture-handler' +
      '|react-native-reanimated' +
      // RN 0.85: reanimated/gesture-handler arrastran react-native-worklets (reemplazó worklets-core),
      // distribuido como ESM → debe transformarse o Jest no parsea su `import`.
      '|react-native-worklets' +
      '|react-native-screens' +
      '|react-native-safe-area-context' +
      '|react-native-config' +
      '|react-native-mmkv' +
      '|@rnmapbox/maps' +
      '|react-native-webrtc' +
      '|react-native-background-geolocation' +
      '|@react-native-firebase' +
      '|@veo' +
      ')/)',
  ],
};
