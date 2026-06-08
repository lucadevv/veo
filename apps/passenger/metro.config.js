const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');

const projectRoot = __dirname;

// Monorepo: los packages @veo/* viven en el repo hermano veo-platform y se
// consumen vía `file:` (symlinks creados por pnpm). Metro necesita observar esas
// carpetas y resolver sus node_modules.
const veoPlatformRoot = path.resolve(projectRoot, '..', 'veo-platform');
const veoPackages = path.resolve(veoPlatformRoot, 'packages');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  // Carpetas extra que Metro debe observar fuera del root del proyecto.
  watchFolders: [veoPackages, path.resolve(veoPlatformRoot, 'node_modules')],
  resolver: {
    // Rutas de node_modules: primero las del proyecto, luego las del monorepo
    // para resolver dependencias transitivas de los packages compartidos.
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(veoPlatformRoot, 'node_modules'),
    ],
    // pnpm usa symlinks; Metro 0.80+ los resuelve nativamente.
    unstable_enableSymlinks: true,
    unstable_enablePackageExports: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
