import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { type ImageStyle, StyleSheet, type TextStyle, type ViewStyle } from 'react-native';
import { passengerTheme, themes, type Theme, type ThemeName } from '../tokens/themes';

const ThemeContext = createContext<Theme>(passengerTheme);

export interface ThemeProviderProps {
  children: ReactNode;
  /** Tema completo (tiene prioridad sobre `name`). */
  theme?: Theme;
  /** Selección por nombre: 'passenger' (marca VEO, negro/cian) | 'driver' (noche/cian). */
  name?: ThemeName;
}

/**
 * Proveedor de tema. Passenger y Driver son apps distintas: cada una monta el provider con su
 * tema y normalmente no lo cambia en runtime (el driver vive en modo noche).
 */
export function ThemeProvider({ children, theme, name = 'passenger' }: ThemeProviderProps) {
  const resolved = theme ?? themes[name];
  return <ThemeContext.Provider value={resolved}>{children}</ThemeContext.Provider>;
}

/** Acceso al tema activo desde cualquier componente. */
export function useTheme(): Theme {
  return useContext(ThemeContext);
}

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

/**
 * Crea estilos dependientes del tema y los memoiza por instancia de tema.
 * Uso: `const styles = useThemedStyles((t) => ({ box: { backgroundColor: t.colors.surface } }))`.
 */
export function useThemedStyles<T extends NamedStyles<T>>(factory: (theme: Theme) => T): T {
  const theme = useTheme();
  // Memoiza por tema: el factory es puro (sólo lee tokens), así evitamos recrear estilos por render.
  return useMemo(() => StyleSheet.create(factory(theme)), [theme]);
}
