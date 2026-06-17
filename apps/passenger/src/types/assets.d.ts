/**
 * Tipado de los assets estáticos importados por la app (imágenes). Metro resuelve estos imports a un
 * id de asset (number) o a un objeto fuente que `Image#source` acepta; `tsc` no los conoce de fábrica,
 * así que los declaramos acá. Permite `import logo from './x.png'` en lugar de `require()`
 * (este último lo prohíbe `@typescript-eslint/no-require-imports`).
 */
declare module '*.png' {
  import type {ImageSourcePropType} from 'react-native';
  const content: ImageSourcePropType;
  export default content;
}

declare module '*.jpg' {
  import type {ImageSourcePropType} from 'react-native';
  const content: ImageSourcePropType;
  export default content;
}
