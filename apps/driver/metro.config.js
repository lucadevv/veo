const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const projectRoot = __dirname;
// Monorepo VEO: esta app vive en apps/driver; los packages @veo/* viven en
// <root>/packages y pnpm los enlaza (workspace:*) por symlink. Metro debe observar
// su código fuente y resolver el node_modules hoisted del root.
const monorepoRoot = path.resolve(projectRoot, '..', '..');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  // Metro vigila el código fuente de los packages del monorepo (algunos exponen
  // `src/*.ts` directamente) y el node_modules hoisted del root.
  watchFolders: [
    path.resolve(monorepoRoot, 'packages'),
    path.resolve(monorepoRoot, 'node_modules'),
  ],
  resolver: {
    // Resolución de módulos: primero el del proyecto, luego el del root (hoisted).
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(monorepoRoot, 'node_modules'),
    ],
    // pnpm enlaza los @veo/* vía symlinks; Metro 0.80+ los resuelve nativamente.
    unstable_enableSymlinks: true,
    // Respeta el campo "exports" de package.json: permite importar submódulos puros
    // (p.ej. `@veo/utils/money`) sin arrastrar el barrel completo, que incluye
    // módulos basados en `node:crypto` inexistentes en Hermes/React Native.
    unstable_enablePackageExports: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
