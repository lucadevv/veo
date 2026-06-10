module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // RN 0.85: ÚNICO plugin de worklets — lo usan reanimated 4 Y los frame processors de
    // vision-camera 5 (react-native-worklets-core quedó REMOVIDO en la migración; y
    // react-native-reanimated/plugin en v4 es solo un alias de este). Debe ir al final.
    'react-native-worklets/plugin',
  ],
};
