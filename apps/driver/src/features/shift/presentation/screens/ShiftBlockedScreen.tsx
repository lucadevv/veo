import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DriverDocument } from '@veo/api-client';
import { Button, SafeScreen, Skeleton, useTheme } from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { NoticeHero } from '../../../../shared/presentation/components/NoticeHero';
import { TopBar } from '../../../../shared/presentation/components/TopBar';
import { IconAlert } from '../../../../shared/presentation/icons';
import {
  documentStatusTone,
  documentTypeI18nKey,
  isBlocking,
  isKnownDocumentType,
} from '../../../documents/domain';
import { DocumentRow } from '../../../documents/presentation/components/DocumentRow';
import { useDocuments } from '../../../documents/presentation/hooks/useDocuments';

type Props = NativeStackScreenProps<RootStackParamList, 'ShiftBlocked'>;

/**
 * Gate al iniciar turno (frame `C/Turno-DocsVencidos`): cuando el vehículo/conductor tiene un
 * documento BLOQUEANTE (vencido o rechazado — `isBlocking`), no se puede iniciar el turno. Muestra
 * el aviso + la(s) fila(s) del documento en falta y ofrece ir a Documentos a actualizarlo. El
 * dashboard enruta aquí ANTES de `ShiftStart` cuando detecta docs bloqueantes; esta pantalla
 * re-consulta la lista (fuente de verdad) y la lista viva por si cambió.
 */
export const ShiftBlockedScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { data, isLoading } = useDocuments();

  const blocking = useMemo(
    () => (data ?? []).filter((doc) => isBlocking(doc.simpleStatus)),
    [data],
  );

  const typeLabel = (raw: string): string =>
    isKnownDocumentType(raw) ? t(documentTypeI18nKey(raw)) : raw;

  // CTA fiel al frame ("Actualizar SOAT"): si hay UN solo documento bloqueante, nombra el documento;
  // si hay varios (o ninguno visible aún), cae a un rótulo genérico. Siempre lleva a Documentos.
  const firstBlocking = blocking[0];
  const actionLabel =
    blocking.length === 1 && firstBlocking
      ? t('shift.blocked.actionOne', { doc: typeLabel(firstBlocking.type) })
      : t('shift.blocked.actionMany');

  return (
    <SafeScreen
      header={<TopBar title={t('shift.startTitle')} onBack={() => navigation.goBack()} />}
      footer={
        <Button
          label={actionLabel}
          variant="primary"
          fullWidth
          onPress={() => navigation.navigate('Documents')}
        />
      }
    >
      <NoticeHero
        tone="warn"
        icon={({ size, color }) => <IconAlert size={size} color={color} strokeWidth={2} />}
        title={t('shift.blocked.title')}
        description={t('shift.blocked.body')}
      >
        {isLoading ? (
          <Skeleton height={64} radius={theme.radii.lg} />
        ) : (
          <View style={styles.list}>
            {blocking.map((doc: DriverDocument, index: number) => {
              const tone = documentStatusTone(doc.simpleStatus);
              return (
                <DocumentRow
                  key={`${doc.type}-${index}`}
                  typeLabel={typeLabel(doc.type)}
                  statusLabel={t(`documents.status.${doc.simpleStatus}`)}
                  statusTone={tone}
                  highlighted
                  highlightColor={theme.colors.danger}
                  onPress={() => navigation.navigate('Documents')}
                />
              );
            })}
          </View>
        )}
      </NoticeHero>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  list: { gap: 8 },
});
