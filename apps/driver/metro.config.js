const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const projectRoot = __dirname;
// Los paquetes @veo/* viven en el monorepo hermano y se enlazan vía `file:`.
const veoPackagesRoot = path.resolve(projectRoot, '../veo-platform/packages');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  // Metro debe vigilar el código fuente de los paquetes del monorepo
  // (algunos exponen `src/*.ts` directamente, no solo `dist`).
  watchFolders: [veoPackagesRoot],
  resolver: {
    // Resolución de módulos: primero los del proyecto, luego los del monorepo.
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(veoPackagesRoot, '../node_modules'),
    ],
    // pnpm enlaza los packages @veo/* vía symlinks; Metro 0.80+ los resuelve nativamente.
    unstable_enableSymlinks: true,
    // Respetar el campo "exports" de package.json: permite importar submódulos puros
    // (p.ej. `@veo/utils/money`) sin arrastrar el barrel completo, que incluye módulos
    // basados en `node:crypto` (ids/crypto) inexistentes en Hermes/React Native.
    unstable_enablePackageExports: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
