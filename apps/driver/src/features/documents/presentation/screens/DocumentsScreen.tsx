import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Banner, Button, SafeScreen, Skeleton, Text, useTheme } from '@veo/ui-kit';
import type { DriverDocument } from '@veo/api-client';
import type { RootStackParamList } from '../../../../navigation/types';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { IconChevronLeft, IconPlus } from '../../../../shared/presentation/icons';
import {
  countDocumentsNeedingAttention,
  documentStatusTone,
  documentTypeI18nKey,
  isKnownDocumentType,
  needsAttention,
  type RegisterDocumentInput,
} from '../../domain';
import { DocumentRow } from '../components/DocumentRow';
import { RegisterDocumentSheet } from '../components/RegisterDocumentSheet';
import { Appear } from '../components/motion';
import { useDocuments, useRegisterDocument } from '../hooks/useDocuments';

type Props = NativeStackScreenProps<RootStackParamList, 'Documents'>;

/**
 * ¿`a` es la versión MÁS ACTUAL del tipo que `b`? Un conductor puede tener varias versiones del mismo tipo
 * (renovaciones), pero la lista muestra UNA por tipo — la vigente. Preferimos la que está `ok` (no requiere
 * atención) y, a igualdad, la de vencimiento más lejano (la renovación más nueva). Sin fecha de creación en
 * el contrato, `expiresAt` es el mejor proxy de "cuál es la actual".
 */
function isMoreCurrent(a: DriverDocument, b: DriverDocument): boolean {
  if (a.ok !== b.ok) return a.ok;
  const ea = a.expiresAt ? Date.parse(a.expiresAt) : 0;
  const eb = b.expiresAt ? Date.parse(b.expiresAt) : 0;
  return ea > eb;
}

/** Deduplica por tipo (un documento por tipo, el vigente). Preserva el orden de primera aparición. */
function dedupeDocumentsByType(docs: DriverDocument[]): DriverDocument[] {
  const byType = new Map<string, DriverDocument>();
  for (const doc of docs) {
    const current = byType.get(doc.type);
    if (!current || isMoreCurrent(doc, current)) byType.set(doc.type, doc);
  }
  return Array.from(byType.values());
}

/** Encabezado con botón de retroceso (pantalla de pila, no es un tab). */
function DocumentsHeader({
  title,
  onBack,
}: {
  title: string;
  onBack: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={onBack}
        hitSlop={8}
        style={({ pressed }) => [
          styles.backBtn,
          { borderRadius: theme.radii.pill },
          pressed ? { backgroundColor: theme.colors.surfaceElevated } : null,
        ]}
      >
        <IconChevronLeft size={24} color={theme.colors.ink} />
      </Pressable>
      <Text variant="title1" numberOfLines={1} style={styles.headerTitle}>
        {title}
      </Text>
    </View>
  );
}

export const DocumentsScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { data, isLoading, isError, error, refetch } = useDocuments();
  const register = useRegisterDocument();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<DriverDocument | null>(null);

  // Una versión por tipo (la vigente): evita duplicados de renovaciones (p. ej. dos "Licencia").
  const documents = useMemo(() => dedupeDocumentsByType(data ?? []), [data]);
  const attentionCount = useMemo(() => countDocumentsNeedingAttention(documents), [documents]);

  const typeLabel = (raw: string): string =>
    isKnownDocumentType(raw) ? t(documentTypeI18nKey(raw)) : raw;

  const openRegister = (doc: DriverDocument | null) => {
    setEditing(doc);
    setSheetOpen(true);
  };

  const handleSubmit = (input: RegisterDocumentInput) => {
    register.mutate(input, {
      onSuccess: () => {
        setSheetOpen(false);
        setEditing(null);
      },
    });
  };

  return (
    <SafeScreen
      scroll
      header={<DocumentsHeader title={t('documents.title')} onBack={() => navigation.goBack()} />}
      footer={
        <View style={styles.footer}>
          <Button
            label={t('documents.addAction')}
            variant="primary"
            fullWidth
            leftIcon={<IconPlus size={20} color={theme.colors.onAccent} />}
            onPress={() => openRegister(null)}
          />
        </View>
      }
    >
      {isLoading ? (
        <View style={[styles.section, { gap: theme.spacing.md }]}>
          <Skeleton height={64} radius={theme.radii.lg} />
          <Skeleton height={72} radius={theme.radii.lg} />
          <Skeleton height={72} radius={theme.radii.lg} />
          <Skeleton height={72} radius={theme.radii.lg} />
        </View>
      ) : isError || !data ? (
        <View style={[styles.section, { gap: theme.spacing.lg }]}>
          <Banner
            tone="danger"
            title={t('errors.generic')}
            description={toErrorMessage(error, t)}
            action={{ label: t('common.retry'), onPress: () => refetch() }}
          />
        </View>
      ) : (
        <View style={[styles.section, { gap: theme.spacing.lg }]}>
          {/* Intro del frame C/Documentos: contexto breve arriba de la lista. */}
          <Text variant="footnote" color="inkMuted">
            {t('documents.intro')}
          </Text>

          {/* Status by exception: banner SOLO si hay algo que atender (por vencer/vencido/rechazado). Si todo
              está al día NO gritamos "todo válido" con un banner verde (era el slop AI que el dueño rechazó). */}
          {attentionCount > 0 ? (
            <Appear>
              <Banner tone="warn" title={t('documents.attention', { count: attentionCount })} />
            </Appear>
          ) : null}

          {documents.length === 0 ? (
            <View
              style={[
                styles.emptyCard,
                {
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                  borderRadius: theme.radii.lg,
                  padding: theme.spacing['2xl'],
                },
              ]}
            >
              <Text variant="callout" color="inkMuted">
                {t('documents.empty')}
              </Text>
            </View>
          ) : (
            <View style={styles.list}>
              {documents.map((doc: DriverDocument, index: number) => {
                const tone = documentStatusTone(doc.simpleStatus);
                const highlight = needsAttention(doc.simpleStatus);
                return (
                  <Appear key={`${doc.type}-${index}`} delay={index * 50} distance={8}>
                    <DocumentRow
                      typeLabel={typeLabel(doc.type)}
                      statusLabel={t(`documents.status.${doc.simpleStatus}`)}
                      statusTone={tone}
                      highlighted={highlight}
                      highlightColor={
                        tone === 'danger'
                          ? theme.colors.danger
                          : tone === 'warn'
                            ? theme.colors.warn
                            : undefined
                      }
                      onPress={() => openRegister(doc)}
                    />
                  </Appear>
                );
              })}
            </View>
          )}
        </View>
      )}

      <RegisterDocumentSheet
        visible={sheetOpen}
        onClose={() => {
          setSheetOpen(false);
          setEditing(null);
        }}
        initialType={editing?.type}
        initialNumber={editing?.documentNumber}
        onSubmit={handleSubmit}
        submitting={register.isPending}
      />
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  header: { paddingTop: 8, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1 },
  section: { paddingTop: 4 },
  list: { gap: 8 },
  emptyCard: { borderWidth: StyleSheet.hairlineWidth },
  footer: { paddingHorizontal: 16, paddingTop: 8 },
});
