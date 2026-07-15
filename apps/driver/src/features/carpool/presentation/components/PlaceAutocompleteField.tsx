import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Card, Text, TextField, useTheme } from '@veo/ui-kit';
import type { PlaceSuggestion } from '@veo/api-client';
import { useAutocomplete } from '../hooks/useAutocomplete';

interface PlaceAutocompleteFieldProps {
  label: string;
  placeholder: string;
  /** Texto inicial (ej. el título del lugar ya elegido al editar). */
  initialText?: string;
  /** Glifo a la izquierda del input (ej. punto de origen lima / pin de destino verde). */
  leftIcon?: React.ReactNode;
  /** Reporta la selección (o `null` si el conductor empezó a re-escribir → hay que re-elegir). */
  onSelect: (place: PlaceSuggestion | null) => void;
}

/**
 * Campo de búsqueda de lugar con autocompletado (origen/destino del carpooling). Dueño de su propio texto;
 * reporta la SELECCIÓN al form vía `onSelect` (el form guarda el `{lat,lng}`). Al re-escribir tras elegir,
 * emite `null` (obliga a re-seleccionar → nunca mandamos coords viejas con un texto nuevo). Las sugerencias
 * salen del `useAutocomplete` (driver-bff → @veo/maps, debounce 250ms, ≥3 chars).
 */
export function PlaceAutocompleteField({
  label,
  placeholder,
  initialText,
  leftIcon,
  onSelect,
}: PlaceAutocompleteFieldProps): React.JSX.Element {
  const theme = useTheme();
  const [text, setText] = useState(initialText ?? '');
  const [focused, setFocused] = useState(false);
  const { suggestions, active } = useAutocomplete(text);

  const showList = focused && active && suggestions.length > 0;

  return (
    <View style={styles.wrap}>
      <TextField
        label={label}
        placeholder={placeholder}
        leftIcon={leftIcon}
        value={text}
        onChangeText={(next) => {
          setText(next);
          onSelect(null);
        }}
        onFocus={() => setFocused(true)}
        // Retardo: deja que el tap de una sugerencia registre antes de ocultar la lista.
        onBlur={() => setTimeout(() => setFocused(false), 200)}
        autoCorrect={false}
      />
      {showList ? (
        <Card padding="sm">
          {suggestions.slice(0, 5).map((s, i) => (
            <Pressable
              key={s.id}
              onPress={() => {
                setText(s.title);
                onSelect(s);
                setFocused(false);
              }}
              accessibilityRole="button"
              style={[
                styles.row,
                i > 0
                  ? {
                      borderTopColor: theme.colors.border,
                      borderTopWidth: StyleSheet.hairlineWidth,
                    }
                  : null,
              ]}
            >
              <Text variant="body" numberOfLines={1}>
                {s.title}
              </Text>
              <Text variant="footnote" color="inkMuted" numberOfLines={1}>
                {s.subtitle}
              </Text>
            </Pressable>
          ))}
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'stretch', gap: 6 },
  row: { paddingVertical: 10, gap: 2 },
});
