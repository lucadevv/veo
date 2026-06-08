import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = (name: string): string => resolve(here, '../../../packages', name, 'src/index.ts');

/**
 * Resolución de los @veo/* hacia su código fuente TS (vite los transpila). Necesario porque
 * @veo/rpc y @veo/api-client exponen `src` directamente y usan ESM con `import.meta`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@veo/rpc': pkg('rpc'),
      '@veo/api-client': pkg('api-client'),
      '@veo/auth': pkg('auth'),
      '@veo/events': pkg('events'),
      '@veo/maps': pkg('maps'),
      '@veo/observability': pkg('observability'),
      '@veo/utils': pkg('utils'),
      '@veo/shared-types': pkg('shared-types'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    globals: false,
  },
});
