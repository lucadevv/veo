import type {DocumentType} from '@veo/api-client';
import {Text, TextField, useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
import {Pressable, StyleSheet, View} from 'react-native';

/** Tipos de documento soportados (orden de presentación: DNI primero, el más común en Perú). */
export const DOCUMENT_TYPES: readonly DocumentType[] = ['DN', 'CE', 'PP'];

export interface DocumentFieldProps {
  /** Tipo de documento elegido (controlado por el contenedor). */
  documentType: DocumentType;
  onChangeDocumentType: (next: DocumentType) => void;
  /** Número de documento (controlado por el contenedor). */
  document: string;
  onChangeDocument: (next: string) => void;
  /** Mensaje de error del campo (validación local o del server). */
  error?: string;
  /** Nota debajo del campo (p. ej. "se guardará en tu perfil"). */
  note?: string;
}

/**
 * Campo COMPARTIDO de documento de identidad: segmento discreto DN/CE/PP (radios accesibles) + el campo
 * de número, con `keyboardType`/`maxLength` derivados del tipo. Es la misma unidad visual en el sheet de
 * vinculación de Yape (primera vez que se carga el documento) y en la edición del perfil, para que el
 * usuario tenga el mismo control y feedback en ambos lugares. La VALIDACIÓN vive en el dominio
 * (`isDocumentValid`); este componente solo presenta y reporta cambios.
 */
export function DocumentField({
  documentType,
  onChangeDocumentType,
  document,
  onChangeDocument,
  error,
  note,
}: DocumentFieldProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const labelFor = (dt: DocumentType): string =>
    dt === 'DN'
      ? t('payments.auto.docTypeDN')
      : dt === 'CE'
        ? t('payments.auto.docTypeCE')
        : t('payments.auto.docTypePP');

  return (
    <View style={{gap: theme.spacing.sm}}>
      {/* Selector de tipo de documento: segmento chico discreto, accesible como radios. */}
      <View style={[styles.segment, {gap: theme.spacing.xs}]}>
        {DOCUMENT_TYPES.map(dt => {
          const on = dt === documentType;
          const label = labelFor(dt);
          return (
            <Pressable
              key={dt}
              accessibilityRole="radio"
              accessibilityState={{selected: on}}
              accessibilityLabel={label}
              onPress={() => onChangeDocumentType(dt)}
              style={({pressed}) => [
                styles.segmentItem,
                {
                  paddingVertical: theme.spacing.xs,
                  paddingHorizontal: theme.spacing.md,
                  borderRadius: theme.radii.md,
                  borderWidth: on ? 2 : 1,
                  borderColor: on ? theme.colors.accent : theme.colors.border,
                  backgroundColor: on
                    ? theme.colors.surfaceElevated
                    : theme.colors.surface,
                  opacity: pressed ? 0.7 : 1,
                },
              ]}>
              <Text variant="subhead" color={on ? 'accent' : 'inkMuted'}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <TextField
        label={t('payments.auto.documentLabel')}
        helperText={
          documentType === 'DN'
            ? t('payments.auto.documentHelperDN')
            : t('payments.auto.documentHelperOther')
        }
        keyboardType={documentType === 'DN' ? 'number-pad' : 'default'}
        autoCapitalize="characters"
        maxLength={12}
        value={document}
        onChangeText={onChangeDocument}
        error={error}
        accessibilityLabel={t('payments.auto.documentLabel')}
      />

      {note ? (
        <Text variant="footnote" color="inkSubtle">
          {note}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  segment: {flexDirection: 'row', flexWrap: 'wrap'},
  segmentItem: {alignItems: 'center', justifyContent: 'center', minHeight: 44},
});
