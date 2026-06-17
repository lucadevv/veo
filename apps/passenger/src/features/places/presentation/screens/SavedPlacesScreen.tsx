import type {MapPoint, PlaceSuggestion} from '@veo/api-client';
import {
  Banner,
  BottomSheet,
  Button,
  Card,
  IconButton,
  ListItem,
  SafeScreen,
  Skeleton,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useCallback, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, View} from 'react-native';
import {useCurrentLocation} from '../../../trip/presentation/hooks/useCurrentLocation';
import {useAutocomplete} from '../../../maps/presentation/hooks/useAutocomplete';
import {
  IconClose,
  IconHome,
  IconStar,
  IconWork,
} from '../../../trip/presentation/components/icons';
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
 * Gestión de Lugares guardados (local, MMKV). Lista Casa/Trabajo/Favoritos, permite agregar, editar
 * y eliminar. El editor busca una dirección (autocompletado real del bff) y guarda solo en el
 * dispositivo. Accesible desde Perfil.
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

        {/* Casa y Trabajo (únicos): si no existen, fila para agregarlos. */}
        <Card variant="outlined" padding="sm">
          {home ? (
            <ListItem
              title={home.label}
              subtitle={home.subtitle}
              leading={<IconHome color={theme.colors.accent} size={20} />}
              trailing={
                <IconButton
                  accessibilityLabel={t('places.removeTitle')}
                  variant="plain"
                  onPress={() => setConfirmRemove(home)}
                  icon={<IconClose color={theme.colors.danger} size={18} />}
                />
              }
              onPress={() =>
                openEditor({
                  kind: 'HOME',
                  id: home.id,
                  label: home.label,
                  subtitle: home.subtitle,
                  point: home.point,
                })
              }
            />
          ) : (
            <ListItem
              title={t('places.home')}
              subtitle={t('places.addHomeHint')}
              leading={<IconHome color={theme.colors.accent} size={20} />}
              chevron
              onPress={() =>
                openEditor({kind: 'HOME', label: t('places.home')})
              }
            />
          )}
          {work ? (
            <ListItem
              title={work.label}
              subtitle={work.subtitle}
              leading={<IconWork color={theme.colors.accent} size={20} />}
              trailing={
                <IconButton
                  accessibilityLabel={t('places.removeTitle')}
                  variant="plain"
                  onPress={() => setConfirmRemove(work)}
                  icon={<IconClose color={theme.colors.danger} size={18} />}
                />
              }
              onPress={() =>
                openEditor({
                  kind: 'WORK',
                  id: work.id,
                  label: work.label,
                  subtitle: work.subtitle,
                  point: work.point,
                })
              }
            />
          ) : (
            <ListItem
              title={t('places.work')}
              subtitle={t('places.addWorkHint')}
              leading={<IconWork color={theme.colors.accent} size={20} />}
              chevron
              onPress={() =>
                openEditor({kind: 'WORK', label: t('places.work')})
              }
            />
          )}
        </Card>

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
              {favorites.map(place => (
                <ListItem
                  key={place.id}
                  title={place.label}
                  subtitle={place.subtitle}
                  leading={<IconStar color={theme.colors.accent} size={20} />}
                  trailing={
                    <IconButton
                      accessibilityLabel={t('places.removeTitle')}
                      variant="plain"
                      onPress={() => setConfirmRemove(place)}
                      icon={<IconClose color={theme.colors.danger} size={18} />}
                    />
                  }
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

        <Button
          label={t('places.addFavorite')}
          variant="secondary"
          fullWidth
          onPress={() => openEditor({kind: 'FAVORITE', label: ''})}
        />

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
          <Button
            label={t('actions.save')}
            fullWidth
            disabled={!canSave}
            onPress={submit}
          />
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
