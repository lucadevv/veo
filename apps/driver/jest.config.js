module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['./jest.setup.js'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transformIgnorePatterns: [
    'node_modules/(?!(' +
      '@react-native' +
      '|react-native' +
      '|@react-navigation' +
      '|react-native-gesture-handler' +
      '|react-native-reanimated' +
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
