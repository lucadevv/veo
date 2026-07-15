import React from 'react';
import { StyleSheet, View } from 'react-native';
import { hexAlpha, Text, useTheme } from '@veo/ui-kit';

/** Tono semántico del aviso a pantalla completa: rojo (crítico) o ámbar (advertencia). */
export type NoticeTone = 'danger' | 'warn';

export interface NoticeHeroProps {
  /** Color del badge/ícono: `danger` (rojo) o `warn` (ámbar). */
  tone: NoticeTone;
  /**
   * Render del ícono del set propio (line-icons). Recibe el tamaño (36) y el color del tono ya
   * resueltos para no hardcodear color en el consumidor.
   */
  icon: (props: { size: number; color: string }) => React.ReactNode;
  title: string;
  description: string;
  /** Contenido extra centrado bajo la descripción (p. ej. la fila del documento vencido). */
  children?: React.ReactNode;
}

/**
 * Héroe CANÓNICO de los avisos a pantalla completa del conductor (frames `C/SinConexion`,
 * `C/Sesion-Cerrada`, `C/Permiso-Ubicacion`, `C/Turno-DocsVencidos`): badge circular tintado con
 * el ícono del set propio + título `display` + descripción `callout` centrada. Centrado vertical y
 * horizontalmente; el consumidor ancla las acciones (footer de `SafeScreen` o inline). Un solo
 * componente reutilizado por los cuatro avisos (regla: 1 patrón = 1 componente, sin copy-paste).
 */
export function NoticeHero({
  tone,
  icon,
  title,
  description,
  children,
}: NoticeHeroProps): React.JSX.Element {
  const theme = useTheme();
  const toneColor = tone === 'danger' ? theme.colors.danger : theme.colors.warn;
  return (
    <View style={styles.container}>
      <View
        style={[
          styles.badge,
          { borderColor: toneColor, backgroundColor: hexAlpha(toneColor, 0.15) },
        ]}
      >
        {icon({ size: 36, color: toneColor })}
      </View>
      <Text variant="title2" align="center">
        {title}
      </Text>
      <Text variant="callout" color="inkSubtle" align="center" style={styles.description}>
        {description}
      </Text>
      {children ? <View style={styles.extra}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  badge: {
    width: 84,
    height: 84,
    borderRadius: 999,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  description: { maxWidth: 290 },
  extra: { alignSelf: 'stretch', marginTop: 8 },
});
