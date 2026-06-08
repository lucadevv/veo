module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // react-native-reanimated/plugin DEBE ser el último plugin de la lista.
    'react-native-reanimated/plugin',
  ],
};
