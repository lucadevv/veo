import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import type { RoutePlace } from '../../../maps/domain/entities';
import type { SavedPlace } from '../../../places/domain/entities';
import { IconHome, IconWork } from './icons';
import { placeToRoute } from './routePlace';
import { ShortcutChip } from './ShortcutChip';

export interface HomeShortcutChipsProps {
  savedPlaces: SavedPlace[];
  onSelect: (place: RoutePlace) => void;
  /** Sin Casa/Trabajo guardado: el chip lleva a agregarlo (pantalla de gestión). */
  onAdd: () => void;
}

/** Casa/Trabajo como pills de 1 toque (anclas, siempre visibles). Si falta, el chip invita a agregar. */
export function HomeShortcutChips({ savedPlaces, onSelect, onAdd }: HomeShortcutChipsProps): React.JSX.Element {
  const { t } = useTranslation();
  const home = savedPlaces.find((p) => p.kind === 'HOME');
  const work = savedPlaces.find((p) => p.kind === 'WORK');
  return (
    <View style={styles.chipsRow}>
      <ShortcutChip
        label={t('home.shortcutHome')}
        Icon={IconHome}
        present={Boolean(home)}
        onPress={() => (home ? onSelect(placeToRoute(home)) : onAdd())}
      />
      <ShortcutChip
        label={t('home.shortcutWork')}
        Icon={IconWork}
        present={Boolean(work)}
        onPress={() => (work ? onSelect(placeToRoute(work)) : onAdd())}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  chipsRow: { flexDirection: 'row', gap: 8 },
});
