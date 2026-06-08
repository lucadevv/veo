import React, {useEffect, useMemo, useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {Banner, BottomSheet, Button, Text, TextField, useTheme} from '@veo/ui-kit';

/** Resultado del formulario: número del documento + vencimiento ISO opcional. */
export interface RegistrationDocumentInput {
  documentNumber: string;
  /** Vencimiento en ISO-8601 (si el conductor lo ingresó / es requerido). */
  expiresAtIso?: string;
}

export interface RegistrationDocumentSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Nombre legible del documento (título del sheet). */
  documentLabel: string;
  /** Exige fecha de vencimiento (p. ej. licencia, que también alimenta el onboarding). */
  requireExpiry?: boolean;
  /** Mutación en curso: deshabilita el CTA y muestra spinner. */
  submitting?: boolean;
  /** Mensaje de error (de la mutación) a mostrar en un Banner. */
  errorMessage?: string;
  onSubmit: (input: RegistrationDocumentInput) => void;
}

/** Acepta `AAAA-MM-DD` y valida que sea un día real; devuelve el ISO o null. */
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
 * Formulario en bottom sheet para registrar un documento del alta (número + vencimiento). El tipo es
 * fijo (lo decide la tarjeta del paso de documentos), por eso no se elige aquí. La carga del archivo
 * binario no está en esta ola; el documento queda "en revisión" tras enviarlo.
 */
export function RegistrationDocumentSheet({
  visible,
  onClose,
  documentLabel,
  requireExpiry = false,
  submitting = false,
  errorMessage,
  onSubmit,
}: RegistrationDocumentSheetProps): React.JSX.Element {
  const {t} = useTranslation();
  const theme = useTheme();

  const [documentNumber, setDocumentNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [touched, setTouched] = useState(false);

  // Reinicia el formulario cada vez que el sheet se abre (cambia de documento).
  useEffect(() => {
    if (visible) {
      setDocumentNumber('');
      setExpiry('');
      setTouched(false);
    }
  }, [visible]);

  const numberError = useMemo(
    () =>
      touched && documentNumber.trim().length === 0
        ? t('registration.documents.numberRequired')
        : undefined,
    [touched, documentNumber, t],
  );

  const expiryError = useMemo(() => {
    if (!touched) {
      return undefined;
    }
    const trimmed = expiry.trim();
    if (trimmed.length === 0) {
      return requireExpiry ? t('registration.documents.expiryRequired') : undefined;
    }
    return parseExpiry(trimmed) ? undefined : t('registration.documents.expiryInvalid');
  }, [touched, expiry, requireExpiry, t]);

  const handleSubmit = () => {
    setTouched(true);
    if (documentNumber.trim().length === 0) {
      return;
    }
    const trimmedExpiry = expiry.trim();
    const parsed = trimmedExpiry.length > 0 ? parseExpiry(trimmedExpiry) : null;
    if (requireExpiry && !parsed) {
      return;
    }
    if (trimmedExpiry.length > 0 && !parsed) {
      return;
    }
    onSubmit({
      documentNumber: documentNumber.trim(),
      ...(parsed ? {expiresAtIso: parsed.iso} : {}),
    });
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={documentLabel}
      footer={
        <View style={styles.footer}>
          <Button label={t('common.cancel')} variant="secondary" onPress={onClose} />
          <Button
            label={t('registration.documents.save')}
            variant="primary"
            loading={submitting}
            onPress={handleSubmit}
          />
        </View>
      }>
      <View style={[styles.body, {gap: theme.spacing.lg}]}>
        <TextField
          label={t('registration.documents.numberLabel')}
          value={documentNumber}
          onChangeText={setDocumentNumber}
          autoCapitalize="characters"
          autoCorrect={false}
          error={numberError}
          required
        />
        <TextField
          label={t('registration.documents.expiryLabel')}
          value={expiry}
          onChangeText={setExpiry}
          placeholder="2026-12-31"
          keyboardType="numbers-and-punctuation"
          autoCorrect={false}
          helperText={t('registration.documents.expiryHelper')}
          error={expiryError}
          required={requireExpiry}
        />
        {errorMessage ? (
          <Banner tone="danger" title={t('errors.generic')} description={errorMessage} />
        ) : null}
        <Text variant="footnote" color="inkSubtle">
          {t('registration.documents.reviewNote')}
        </Text>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: {paddingBottom: 8},
  footer: {flexDirection: 'row', justifyContent: 'flex-end', gap: 12},
});
