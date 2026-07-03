import type {MapPoint, PlaceSuggestion} from '@veo/api-client';
import {
  Banner,
  BottomSheet,
  Button,
  Card,
  hexAlpha,
  ListItem,
  SafeScreen,
  Skeleton,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useCallback, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, StyleSheet, View} from 'react-native';
import {useCurrentLocation} from '../../../trip/presentation/hooks/useCurrentLocation';
import {useAutocomplete} from '../../../maps/presentation/hooks/useAutocomplete';
import {
  IconHome,
  IconPlus,
  IconStar,
  IconWork,
} from '../../../trip/presentation/components/icons';
import {IconPencil} from '../../../auth/presentation/components/icons';
import type {
  SavedPlace,
  SavedPlaceInput,
  SavedPlaceKind,
} from '../../domain/entities';
import {useSavedPlacesStore} from '../stores/savedPlacesStore';

interface EditorState {
  kind: SavedPlaceKind;
  /** Id si se está editando; undefined si es alta. */
  id?: string;
  label: string;
  subtitle?: string;
  point?: MapPoint;
}

/**
 * Gestión de Lugares guardados. La persistencia REAL es `HttpSavedPlacesRepository` (BFF `/places` +
 * caché MMKV offline-first): los lugares SE SINCRONIZAN con la cuenta — la nota del pen ("solo en este
 * dispositivo") era falsa y NO se copia; el copy `places.localNote` dice la verdad. Layout per
 * design/veo.pen b7muEo: Casa y Trabajo como DOS cards prominentes (icono en círculo + label +
 * dirección + pencil), favoritos en card-lista con divider, fila "Agregar lugar" al pie. El borrado
 * vive en el editor (las filas ya no llevan la X: la fila es pen-fiel; el sheet de confirmación se
 * conserva).
 */
export function SavedPlacesScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const places = useSavedPlacesStore(s => s.places);
  const save = useSavedPlacesStore(s => s.save);
  const update = useSavedPlacesStore(s => s.update);
  const remove = useSavedPlacesStore(s => s.remove);

  const {point: myLocation} = useCurrentLocation();
  const near = useMemo<MapPoint | null>(
    () => (myLocation ? {lat: myLocation.lat, lng: myLocation.lon} : null),
    [myLocation],
  );

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<SavedPlace | null>(null);
  const [query, setQuery] = useState('');

  const {suggestions, loading, active} = useAutocomplete(query, near);

  const home = places.find(p => p.kind === 'HOME');
  const work = places.find(p => p.kind === 'WORK');
  const favorites = places.filter(p => p.kind === 'FAVORITE');

  const openEditor = useCallback((state: EditorState) => {
    setQuery('');
    setEditor(state);
  }, []);

  const pickSuggestion = useCallback((suggestion: PlaceSuggestion) => {
    setEditor(prev =>
      prev
        ? {
            ...prev,
            point: {lat: suggestion.lat, lng: suggestion.lng},
            subtitle: suggestion.subtitle ?? suggestion.title,
            // Para favoritos sin nombre propio, propón el título como etiqueta.
            label:
              prev.label ||
              (prev.kind === 'FAVORITE' ? suggestion.title : prev.label),
          }
        : prev,
    );
    setQuery('');
  }, []);

  const canSave =
    Boolean(editor?.point) && (editor?.label.trim().length ?? 0) >= 1;

  const submit = useCallback(() => {
    if (!editor?.point) {
      return;
    }
    const input: SavedPlaceInput = {
      kind: editor.kind,
      label: editor.label.trim(),
      point: editor.point,
      ...(editor.subtitle ? {subtitle: editor.subtitle} : {}),
    };
    if (editor.id) {
      update(editor.id, input);
    } else {
      save(input);
    }
    setEditor(null);
  }, [editor, save, update]);

  // Borrado desde el EDITOR: per pen las filas ya no llevan la X, así que la única puerta al borrado
  // es editar el lugar. Cierra el editor y abre el sheet de confirmación EXISTENTE (se conserva).
  const requestRemoveFromEditor = useCallback(() => {
    if (!editor?.id) {
      return;
    }
    const place = places.find(p => p.id === editor.id);
    setEditor(null);
    if (place) {
      setConfirmRemove(place);
    }
  }, [editor, places]);

  return (
    <SafeScreen padded={false}>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.xl,
          gap: theme.spacing.lg,
        }}>
        <Text variant="footnote" color="inkMuted">
          {t('places.subtitle')}
        </Text>

        {/* Casa y Trabajo per pen b7muEo: DOS cards separadas y prominentes (icono en círculo +
            label + dirección + pencil). Vacías, la MISMA card invita a agregar (affordance plus). */}
        <View style={{gap: theme.spacing.md}}>
          <PrimaryPlaceCard
            kind="HOME"
            place={home}
            onPress={() =>
              home
                ? openEditor({
                    kind: 'HOME',
                    id: home.id,
                    label: home.label,
                    subtitle: home.subtitle,
                    point: home.point,
                  })
                : openEditor({kind: 'HOME', label: t('places.home')})
            }
          />
          <PrimaryPlaceCard
            kind="WORK"
            place={work}
            onPress={() =>
              work
                ? openEditor({
                    kind: 'WORK',
                    id: work.id,
                    label: work.label,
                    subtitle: work.subtitle,
                    point: work.point,
                  })
                : openEditor({kind: 'WORK', label: t('places.work')})
            }
          />
        </View>

        {/* Favoritos */}
        <View>
          <Text
            variant="subhead"
            color="inkMuted"
            style={{marginBottom: theme.spacing.sm}}>
            {t('places.favorites')}
          </Text>
          {favorites.length > 0 ? (
            <Card variant="outlined" padding="sm">
              {/* El pen dibuja íconos por favorito (dumbbell/heart), pero el modelo `SavedPlace` NO
                  tiene campo de ícono → IconStar homogéneo (gap de modelo reportado). El chevron
                  abre el editor (el borrado vive dentro del editor, per pen sin X en la fila). */}
              {favorites.map(place => (
                <ListItem
                  key={place.id}
                  title={place.label}
                  subtitle={place.subtitle}
                  leading={<IconStar color={theme.colors.accent} size={20} />}
                  chevron
                  onPress={() =>
                    openEditor({
                      kind: 'FAVORITE',
                      id: place.id,
                      label: place.label,
                      subtitle: place.subtitle,
                      point: place.point,
                    })
                  }
                />
              ))}
            </Card>
          ) : (
            <Card variant="outlined" padding="lg">
              <Text variant="body" color="inkMuted" align="center">
                {t('places.empty')}
              </Text>
              <Text
                variant="footnote"
                color="inkSubtle"
                align="center"
                style={{marginTop: theme.spacing.xs}}>
                {t('places.emptySubtitle')}
              </Text>
            </Card>
          )}
        </View>

        {/* Fila "Agregar lugar" per pen b7muEo (plus en círculo brand tenue + label), en vez del
            botón suelto. Agrega un favorito (Casa/Trabajo se agregan desde sus propias cards). */}
        <ListItem
          title={t('places.addPlace')}
          leading={
            <View
              style={[
                styles.addIconWrap,
                {
                  backgroundColor: hexAlpha(
                    theme.colors.accent,
                    theme.scheme === 'dark' ? 0.16 : 0.12,
                  ),
                },
              ]}>
              <IconPlus color={theme.colors.accent} size={20} />
            </View>
          }
          onPress={() => openEditor({kind: 'FAVORITE', label: ''})}
        />

        {/* Nota al pie: dice la VERDAD del repo (HTTP /places + caché offline), no lo del pen. */}
        <Text variant="footnote" color="inkSubtle" align="center">
          {t('places.localNote')}
        </Text>
      </ScrollView>

      {/* Editor (alta/edición) */}
      <BottomSheet
        visible={editor != null}
        onClose={() => setEditor(null)}
        title={editor?.id ? t('places.editTitle') : t('places.addTitle')}
        footer={
          <View style={{gap: theme.spacing.sm}}>
            <Button
              label={t('actions.save')}
              fullWidth
              disabled={!canSave}
              onPress={submit}
            />
            {/* Editando un lugar existente, el borrado vive acá (la fila ya no lleva X per pen). */}
            {editor?.id ? (
              <Button
                label={t('places.deletePlace')}
                variant="ghost"
                fullWidth
                onPress={requestRemoveFromEditor}
              />
            ) : null}
          </View>
        }>
        {editor ? (
          <View style={{gap: theme.spacing.md}}>
            {editor.kind === 'FAVORITE' ? (
              <TextField
                label={t('places.labelLabel')}
                placeholder={t('places.labelPlaceholder')}
                value={editor.label}
                onChangeText={label =>
                  setEditor(prev => (prev ? {...prev, label} : prev))
                }
                maxLength={40}
              />
            ) : null}

            <View>
              <Text
                variant="footnote"
                color="inkMuted"
                style={{marginBottom: theme.spacing.xs}}>
                {t('places.pickLabel')}
              </Text>
              {editor.subtitle ? (
                <Banner
                  tone="success"
                  title={editor.subtitle}
                  style={{marginBottom: theme.spacing.sm}}
                />
              ) : (
                <Text
                  variant="footnote"
                  color="inkSubtle"
                  style={{marginBottom: theme.spacing.sm}}>
                  {t('places.pickHelper')}
                </Text>
              )}
              <TextField
                label={t('places.pickAction')}
                placeholder={t('maps.inputPlaceholder')}
                value={query}
                onChangeText={setQuery}
                autoCorrect={false}
                returnKeyType="search"
              />
            </View>

            {loading ? (
              <View style={{gap: theme.spacing.sm}}>
                <Skeleton variant="text" height={18} />
                <Skeleton variant="text" height={18} />
              </View>
            ) : (
              <View>
                {suggestions.map(item => (
                  <ListItem
                    key={item.id}
                    title={item.title}
                    subtitle={item.subtitle}
                    leading={
                      <Text variant="bodyStrong" color="inkSubtle">
                        ◍
                      </Text>
                    }
                    onPress={() => pickSuggestion(item)}
                  />
                ))}
                {active && suggestions.length === 0 && !loading ? (
                  <Text variant="footnote" color="inkSubtle" align="center">
                    {t('maps.noResults')}
                  </Text>
                ) : null}
              </View>
            )}
          </View>
        ) : null}
      </BottomSheet>

      {/* Confirmar eliminación */}
      <BottomSheet
        visible={confirmRemove != null}
        onClose={() => setConfirmRemove(null)}
        title={t('places.removeTitle')}
        footer={
          <View style={{gap: theme.spacing.sm}}>
            <Button
              label={t('actions.delete')}
              variant="danger"
              fullWidth
              onPress={() => {
                if (confirmRemove) {
                  remove(confirmRemove.id);
                }
                setConfirmRemove(null);
              }}
            />
            <Button
              label={t('actions.cancel')}
              variant="ghost"
              fullWidth
              onPress={() => setConfirmRemove(null)}
            />
          </View>
        }>
        <Text variant="callout" color="inkMuted">
          {t('places.removeBody')}
        </Text>
      </BottomSheet>
    </SafeScreen>
  );
}

interface PrimaryPlaceCardProps {
  kind: 'HOME' | 'WORK';
  /** El lugar guardado; undefined = vacío (la card invita a agregar con la misma affordance). */
  place?: SavedPlace;
  onPress: () => void;
}

/**
 * Card prominente de Casa/Trabajo (design/veo.pen b7muEo): icono en círculo (Casa = brand sobre brand
 * tenue; Trabajo = inkMuted sobre superficie elevada, como distingue el pen) + label + dirección +
 * pencil de editar a la derecha. Vacía muestra el hint de agregar y un plus (mismo affordance).
 */
function PrimaryPlaceCard({
  kind,
  place,
  onPress,
}: PrimaryPlaceCardProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const isHome = kind === 'HOME';
  const iconColor = isHome ? theme.colors.accent : theme.colors.inkMuted;
  const wrapBg = isHome
    ? hexAlpha(theme.colors.accent, theme.scheme === 'dark' ? 0.16 : 0.12)
    : theme.colors.surfaceElevated;
  const title = place?.label ?? t(isHome ? 'places.home' : 'places.work');
  const subtitle =
    place?.subtitle ??
    t(isHome ? 'places.addHomeHint' : 'places.addWorkHint');

  return (
    <Card
      variant="outlined"
      padding="lg"
      onPress={onPress}
      accessibilityLabel={`${title}. ${subtitle}`}>
      <View style={styles.primaryRow}>
        <View style={[styles.iconWrap, {backgroundColor: wrapBg}]}>
          {isHome ? (
            <IconHome color={iconColor} size={20} />
          ) : (
            <IconWork color={iconColor} size={20} />
          )}
        </View>
        <View style={styles.primaryTexts}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {title}
          </Text>
          <Text variant="footnote" color="inkSubtle" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {/* Lleno = pencil de editar (per pen); vacío = plus de agregar (mismo affordance). */}
        {place ? (
          <IconPencil color={theme.colors.inkSubtle} size={18} />
        ) : (
          <IconPlus color={theme.colors.inkSubtle} size={18} />
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  primaryRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  primaryTexts: {flex: 1, gap: 2},
  // Círculo de 44 del icono (pen: IconWrap 44 con r-pill).
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
