# @veo/shared-config

Configuración compartida del monorepo.

## Uso

### ESLint

```js
// eslint.config.mjs (servicio NestJS)
import nodeConfig from '@veo/shared-config/eslint/node';
export default nodeConfig;
```

### tsconfig

```json
// tsconfig.json del servicio
{ "extends": "@veo/shared-config/tsconfig/nestjs" }
```

### Jest

```js
// jest.config.js
module.exports = require('@veo/shared-config/jest/node');
```
