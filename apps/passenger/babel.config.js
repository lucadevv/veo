module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // Worklets de VisionCamera (frame processors de detección facial). Debe ir ANTES de reanimated.
    'react-native-worklets-core/plugin',
    // react-native-reanimated/plugin DEBE ir siempre al final de la lista.
    'react-native-reanimated/plugin',
  ],
};
