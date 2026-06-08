import React, {useEffect, useMemo, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {Banner, BottomSheet, Button, Text, TextField, useTheme} from '@veo/ui-kit';
import {
  DEFAULT_SUPPORT_CATEGORY,
  SUPPORT_CATEGORIES,
  supportCategoryI18nKey,
  validateTicketDraft,
  type SupportCategory,
  type TicketDraft,
} from '../../domain';

export interface ReportProblemSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Viaje a adjuntar al ticket (p. ej. el viaje activo). Si se pasa, se ofrece adjuntarlo. */
  tripId?: string;
  /** Categoría inicial preseleccionada. */
  initialCategory?: SupportCategory;
  /** Envía el borrador; el contenedor gestiona la mutación. */
  onSubmit: (draft: TicketDraft) => void;
  /** Mutación en curso (deshabilita el CTA y muestra spinner). */
  submitting?: boolean;
}

/**
 * Formulario "Reportar un problema" en bottom sheet: categoría (chips) + asunto + mensaje + adjuntar
 * el viaje relacionado (si lo hay). Validación inline al intentar enviar (longitudes mínimas). Sigue
 * el tema noche y deja el CTA fijo sobre el inset inferior. No escribe nada hasta tocar enviar.
 */
export function ReportProblemSheet({
  visible,
  onClose,
  tripId,
  initialCategory,
  onSubmit,
  submitting = false,
}: ReportProblemSheetProps): React.JSX.Element {
  const {t} = useTranslation();
  const theme = useTheme();

  const [category, setCategory] = useState<SupportCategory>(initialCategory ?? DEFAULT_SUPPORT_CATEGORY);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [attachTrip, setAttachTrip] = useState(true);
  const [touched, setTouched] = useState(false);

  // Reinicia el borrador cada vez que el sheet se abre.
  useEffect(() => {
    if (visible) {
      setCategory(initialCategory ?? DEFAULT_SUPPORT_CATEGORY);
      setSubject('');
      setBody('');
      setAttachTrip(true);
      setTouched(false);
    }
  }, [visible, initialCategory]);

  const draft: TicketDraft = useMemo(
    () => ({
      category,
      subject,
      body,
      ...(tripId && attachTrip ? {tripId} : {}),
    }),
    [category, subject, body, tripId, attachTrip],
  );

  const errors = useMemo(() => (touched ? validateTicketDraft(draft) : {}), [touched, draft]);

  const handleSubmit = () => {
    setTouched(true);
    const validationErrors = validateTicketDraft(draft);
    if (Object.keys(validationErrors).length > 0) {
      return;
    }
    onSubmit(draft);
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('support.form.title')}
      footer={
        <View style={styles.footer}>
          <Button label={t('common.cancel')} variant="secondary" onPress={onClose} />
          <Button
            label={t('support.form.submit')}
            variant="primary"
            loading={submitting}
            onPress={handleSubmit}
          />
        </View>
      }>
      <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
        <View style={[styles.field, {gap: theme.spacing.sm}]}>
          <Text variant="label" color="inkMuted">
            {t('support.form.categoryLabel')}
          </Text>
          <View style={[styles.chips, {gap: theme.spacing.sm}]}>
            {SUPPORT_CATEGORIES.map(cat => {
              const selected = cat === category;
              return (
                <Pressable
                  key={cat}
                  accessibilityRole="button"
                  accessibilityState={{selected}}
                  onPress={() => setCategory(cat)}
                  style={({pressed}) => [
                    styles.chip,
                    {
                      borderRadius: theme.radii.pill,
                      borderColor: selected ? theme.colors.accent : theme.colors.border,
                      backgroundColor: selected ? theme.colors.surfaceElevated : theme.colors.surface,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}>
                  <Text variant="footnote" color={selected ? 'accent' : 'inkMuted'} numberOfLines={1}>
                    {t(supportCategoryI18nKey(cat))}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.field}>
          <TextField
            label={t('support.form.subjectLabel')}
            value={subject}
            onChangeText={setSubject}
            error={errors.subject ? t(errors.subject) : undefined}
            maxLength={120}
            required
          />
        </View>

        <View style={styles.field}>
          <TextField
            label={t('support.form.bodyLabel')}
            value={body}
            onChangeText={setBody}
            multiline
            error={errors.body ? t(errors.body) : undefined}
            helperText={t('support.form.bodyHelper')}
            required
          />
        </View>

        {tripId ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{checked: attachTrip}}
            onPress={() => setAttachTrip(prev => !prev)}
            style={styles.field}>
            <Banner
              tone={attachTrip ? 'success' : 'info'}
              title={t('support.form.attachTrip')}
              description={attachTrip ? t('support.form.attachTripOn') : t('support.form.attachTripOff')}
            />
          </Pressable>
        ) : null}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: {maxHeight: 460},
  field: {marginBottom: 16},
  chips: {flexDirection: 'row', flexWrap: 'wrap'},
  chip: {paddingHorizontal: 14, paddingVertical: 8, borderWidth: StyleSheet.hairlineWidth},
  footer: {flexDirection: 'row', justifyContent: 'flex-end', gap: 12},
});
