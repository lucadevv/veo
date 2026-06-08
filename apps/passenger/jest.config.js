module.exports = {
  preset: 'react-native',
  setupFiles: ['./jest.setup.js'],
  // Permite ejecutar la suite aunque todavía no existan tests (scaffold).
  passWithNoTests: true,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  // Transformar los módulos RN y los packages compartidos @veo/* (TS sin compilar).
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-.*|@veo/.*)/)',
  ],
};
