module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // reanimated 4: el plugin canónico es react-native-worklets/plugin (el de
    // react-native-reanimated quedó como alias). DEBE ser el último plugin de la lista.
    'react-native-worklets/plugin',
  ],
};
