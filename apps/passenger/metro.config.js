const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

const projectRoot = __dirname;
// Monorepo VEO: esta app vive en apps/passenger; los packages @veo/* viven en
// <root>/packages y pnpm los enlaza (workspace:*) por symlink. Metro debe observar
// el código fuente de esos packages y resolver el node_modules hoisted del root.
const monorepoRoot = path.resolve(projectRoot, '..', '..');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  // Carpetas extra que Metro observa fuera del proyecto: el código de los packages
  // compartidos y el node_modules hoisted del monorepo (deps transitivas).
  watchFolders: [
    path.resolve(monorepoRoot, 'packages'),
    path.resolve(monorepoRoot, 'node_modules'),
  ],
  resolver: {
    // Rutas de node_modules: primero el del proyecto, luego el del root (donde pnpm
    // hoistea todas las deps por node-linker=hoisted).
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(monorepoRoot, 'node_modules'),
    ],
    // pnpm enlaza los @veo/* vía symlinks; Metro 0.80+ los resuelve nativamente.
    unstable_enableSymlinks: true,
    // Respeta el campo "exports": permite importar submódulos puros (p.ej.
    // `@veo/utils/money`) sin arrastrar el barrel completo, que incluye módulos
    // basados en `node:crypto` (ids/crypto) inexistentes en Hermes/React Native.
    unstable_enablePackageExports: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
