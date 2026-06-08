import React, {useEffect, useMemo, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {BottomSheet, Button, Text, TextField, useTheme} from '@veo/ui-kit';
import {
  DOCUMENT_TYPES,
  documentTypeI18nKey,
  type DocumentType,
  type RegisterDocumentInput,
} from '../../domain';

export interface RegisterDocumentSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Tipo preseleccionado (al "actualizar" una fila existente). */
  initialType?: string;
  /** Número preexistente (al actualizar). */
  initialNumber?: string;
  /** Envía el registro; el contenedor gestiona la mutación. */
  onSubmit: (input: RegisterDocumentInput) => void;
  /** Mutación en curso (deshabilita el CTA y muestra spinner). */
  submitting?: boolean;
}

/** Acepta una fecha exacta `AAAA-MM-DD` y valida que sea un día real (no 2026-13-40). */
function parseExpiry(raw: string): {iso: string} | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rechaza fechas que se "desbordan" (ej. 31 de febrero → marzo) comparando componentes.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return {iso: date.toISOString()};
}

/**
 * Formulario en bottom sheet para registrar/actualizar un documento (metadatos de esta ola: tipo +
 * número + vencimiento). La subida del archivo binario NO está en esta ola, por eso el sheet solo
 * captura texto. Validación inline al intentar enviar; respeta el tema noche y deja el CTA fijo
 * sobre el inset inferior.
 */
export function RegisterDocumentSheet({
  visible,
  onClose,
  initialType,
  initialNumber,
  onSubmit,
  submitting = false,
}: RegisterDocumentSheetProps): React.JSX.Element {
  const {t} = useTranslation();
  const theme = useTheme();

  const [type, setType] = useState<string>(initialType ?? DOCUMENT_TYPES[0]);
  const [documentNumber, setDocumentNumber] = useState(initialNumber ?? '');
  const [expiry, setExpiry] = useState('');
  const [touched, setTouched] = useState(false);

  // Re-sincroniza los valores iniciales cada vez que el sheet se abre (cambia de documento).
  useEffect(() => {
    if (visible) {
      setType(initialType ?? DOCUMENT_TYPES[0]);
      setDocumentNumber(initialNumber ?? '');
      setExpiry('');
      setTouched(false);
    }
  }, [visible, initialType, initialNumber]);

  const numberError = useMemo(
    () => (touched && documentNumber.trim().length === 0 ? t('documents.form.numberRequired') : undefined),
    [touched, documentNumber, t],
  );
  const expiryError = useMemo(() => {
    if (!touched || expiry.trim().length === 0) {
      return undefined;
    }
    return parseExpiry(expiry) ? undefined : t('documents.form.expiryInvalid');
  }, [touched, expiry, t]);

  const handleSubmit = () => {
    setTouched(true);
    if (documentNumber.trim().length === 0) {
      return;
    }
    // El vencimiento es opcional, pero si se ingresó debe ser válido.
    const parsed = expiry.trim().length > 0 ? parseExpiry(expiry) : null;
    if (expiry.trim().length > 0 && !parsed) {
      return;
    }
    onSubmit({
      type,
      documentNumber: documentNumber.trim(),
      ...(parsed ? {expiresAt: parsed.iso} : {}),
    });
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('documents.form.title')}
      footer={
        <View style={styles.footer}>
          <Button label={t('common.cancel')} variant="secondary" onPress={onClose} />
          <Button
            label={t('documents.form.submit')}
            variant="primary"
            loading={submitting}
            onPress={handleSubmit}
          />
        </View>
      }>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
        <View style={[styles.field, {gap: theme.spacing.sm}]}>
          <Text variant="label" color="inkMuted">
            {t('documents.form.typeLabel')}
          </Text>
          <View style={[styles.typeGrid, {gap: theme.spacing.sm}]}>
            {DOCUMENT_TYPES.map((dt: DocumentType) => {
              const selected = dt === type;
              return (
                <Pressable
                  key={dt}
                  accessibilityRole="button"
                  accessibilityState={{selected}}
                  onPress={() => setType(dt)}
                  style={({pressed}) => [
                    styles.typeChip,
                    {
                      borderRadius: theme.radii.pill,
                      borderColor: selected ? theme.colors.accent : theme.colors.border,
                      backgroundColor: selected
                        ? theme.colors.surfaceElevated
                        : theme.colors.surface,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}>
                  <Text
                    variant="footnote"
                    color={selected ? 'accent' : 'inkMuted'}
                    numberOfLines={1}>
                    {t(documentTypeI18nKey(dt))}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.field}>
          <TextField
            label={t('documents.form.numberLabel')}
            value={documentNumber}
            onChangeText={setDocumentNumber}
            autoCapitalize="characters"
            autoCorrect={false}
            error={numberError}
            required
          />
        </View>

        <View style={styles.field}>
          <TextField
            label={t('documents.form.expiryLabel')}
            value={expiry}
            onChangeText={setExpiry}
            placeholder="2026-12-31"
            keyboardType="numbers-and-punctuation"
            autoCorrect={false}
            helperText={t('documents.form.expiryHelper')}
            error={expiryError}
          />
        </View>

        <Text variant="footnote" color="inkSubtle" style={styles.note}>
          {t('documents.form.reviewNote')}
        </Text>
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: {maxHeight: 420},
  field: {marginBottom: 16},
  typeGrid: {flexDirection: 'row', flexWrap: 'wrap'},
  typeChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  note: {marginTop: 4},
  footer: {flexDirection: 'row', justifyContent: 'flex-end', gap: 12},
});
