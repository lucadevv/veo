import {useQuery} from '@tanstack/react-query';
import {OFFERING_LIST} from '@veo/shared-types';
import {Text, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {StyleSheet, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {
  MAP_GLYPH_DEFAULTS,
  offeringDisplayName,
  offeringGlyph,
} from '../../../../shared/presentation/components/offeringGlyphs';

/** Una oferta a pintar en la teaser (normalizada: del backend o del catálogo de código). */
interface TeaserItem {
  id: string;
  labelKey: string;
  icon: string;
  name: string;
}

/**
 * Fallback de código (degradación honesta): el catálogo base por sortOrder, SOLO las ofertas visibles por
 * default. B5-4: las verticales especiales + EV (defaultEnabled:false) nacen ocultas — no se muestran en la
 * teaser ni cuando el fetch del catálogo falla (el backend ya filtra igual; la app NO debe leakearlas).
 */
const CODE_FALLBACK: TeaserItem[] = OFFERING_LIST.filter(
  o => o.defaultEnabled,
).map(o => ({
  id: o.id,
  labelKey: o.labelKey,
  icon: o.icon as string,
  name: o.id,
}));

/**
 * TEASER del catálogo de servicios en el Home idle (debajo de los chips Casa/Trabajo): una fila de
 * tarjetas chicas, una por oferta ACTIVA, cada una = silueta top-down del vehículo + nombre. INFORMATIVO,
 * NO seleccionable: sin destino no hay cotización, así que NO mostramos precio (degradación honesta).
 *
 * SERVER-DRIVEN (Fase B/B1f): la lista sale de `GET /maps/catalog` — solo las ofertas que el admin tiene
 * HABILITADAS (ADR 013). Degradación honesta: mientras carga o si la red falla, mostramos el catálogo de
 * CÓDIGO (`OFFERING_LIST`) — la teaser es informativa, mejor el menú base que una pantalla vacía o un
 * skeleton parpadeante. Si el admin apagó TODAS las ofertas (fetch OK pero lista vacía), ocultamos la
 * sección entera: no hay servicios que mostrar. El ícono se resuelve por el registro token→glyph y el
 * nombre por i18n (`labelKey`, con fallback al `name` del server). Todo por tokens del tema.
 */
export function OfferingsTeaser(): React.JSX.Element | null {
  const theme = useTheme();
  const {t} = useTranslation();
  const getCatalog = useDependency(TOKENS.getCatalogUseCase);

  const catalogQuery = useQuery({
    queryKey: ['maps', 'catalog'],
    queryFn: () => getCatalog.execute(),
    staleTime: 60_000,
  });

  // Server-driven con fallback: el catálogo activo del backend, o el de código mientras carga / si falla.
  // `?? ` solo cae al fallback con data ausente (loading/error); una lista VACÍA de un fetch OK (admin
  // apagó todo) se respeta tal cual → la sección se oculta abajo.
  const items: TeaserItem[] = catalogQuery.data?.offerings ?? CODE_FALLBACK;

  // Admin apagó todas (fetch exitoso, lista vacía): no hay servicios → no mostramos la sección.
  if (items.length === 0) return null;

  return (
    <View style={{gap: theme.spacing.md}}>
      <Text variant="caption" color="inkSubtle">
        {t('home.servicesTitle')}
      </Text>
      <View style={[styles.grid, {gap: theme.spacing.sm}]}>
        {items.map(offering => {
          const glyph = offeringGlyph({icon: offering.icon});
          return (
            <View
              key={offering.id}
              style={[
                styles.cell,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radii.md,
                  paddingVertical: theme.spacing.md,
                  paddingHorizontal: theme.spacing.xs,
                  gap: theme.spacing.xs,
                },
              ]}>
              <glyph.MapGlyph
                size={MAP_GLYPH_DEFAULTS.size}
                bodyColor={theme.colors.ink}
                glassColor={theme.colors.surface}
              />
              <Text
                variant="caption"
                color="inkMuted"
                numberOfLines={1}
                style={styles.label}>
                {offeringDisplayName({
                  labelKey: offering.labelKey,
                  name: offering.name,
                })}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Fila de iguales: cada celda toma su fracción del ancho (escala sola al crecer el catálogo).
  grid: {flexDirection: 'row'},
  cell: {flex: 1, borderWidth: 1, alignItems: 'center'},
  label: {textAlign: 'center'},
});
