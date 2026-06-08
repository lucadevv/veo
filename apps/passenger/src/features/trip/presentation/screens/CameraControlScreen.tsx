import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Banner, Button, Card, SafeScreen, Text, useTheme } from '@veo/ui-kit';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, StyleSheet, View } from 'react-native';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import type { RootStackParamList } from '../../../../navigation/types';
import { ErrorState, LoadingState } from '../../../../shared/presentation/components/ScreenStates';
import type { TrustedContact } from '../../../contacts/domain/entities';
import { hexAlpha } from '../components/color';
import { IconCamera, IconChild, IconLock, IconUsers } from '../components/icons';
import { Toggle } from '../components/Toggle';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type Params = RouteProp<RootStackParamList, 'CameraControl'>;

/**
 * Control de cámara (Ola 2A · privacidad). El pasajero decide quién ve la cámara de su viaje:
 * master toggle "compartir con mi familia" + lista de CONTACTOS VERIFICADOS reales (de
 * `contactsRepository`) con toggle por contacto, tarjeta de control parental, nota de cifrado y
 * Guardar. Fiel al diseño `CameraControl`.
 *
 * HUECO DE BACKEND (degradación honesta): NO existe endpoint soberano "quién ve la cámara". La
 * preferencia se persiste LOCALMENTE (MMKV) vía `SaveCameraSharePreferenceUseCase` y la UI avisa
 * (banner) que se aplicará cuando el conductor inicie el viaje / exista el servicio — nunca simula
 * que ya se está compartiendo. Ver `cameraShareRepository.ts`.
 */
export function CameraControlScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Params>();
  const { tripId } = params;

  const listContacts = useDependency(TOKENS.listContactsUseCase);
  const getPreference = useDependency(TOKENS.getCameraSharePreferenceUseCase);
  const savePreference = useDependency(TOKENS.saveCameraSharePreferenceUseCase);

  const contactsQuery = useQuery({
    queryKey: ['contacts'],
    queryFn: () => listContacts.execute(),
  });
  const preferenceQuery = useQuery({
    queryKey: ['cameraShare', tripId],
    queryFn: () => getPreference.execute(tripId),
  });

  // Estado de UI hidratado desde la preferencia persistida una sola vez (al resolver la query).
  const [shareWithFamily, setShareWithFamily] = useState(false);
  const [allowed, setAllowed] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (preferenceQuery.data && !hydrated) {
      setShareWithFamily(preferenceQuery.data.shareWithFamily);
      setAllowed(new Set(preferenceQuery.data.allowedContactIds));
      setHydrated(true);
    }
  }, [preferenceQuery.data, hydrated]);

  const saveMutation = useMutation({
    mutationFn: () =>
      savePreference.execute(tripId, {
        shareWithFamily,
        allowedContactIds: Array.from(allowed),
      }),
    onSuccess: () => {
      setSaved(true);
      // Notifica "Preferencias guardadas" y vuelve, igual que el diseño.
      navigation.goBack();
    },
  });

  if (contactsQuery.isLoading || preferenceQuery.isLoading) {
    return (
      <SafeScreen>
        <LoadingState />
      </SafeScreen>
    );
  }
  if (contactsQuery.isError) {
    return (
      <SafeScreen>
        <ErrorState onRetry={() => contactsQuery.refetch()} />
      </SafeScreen>
    );
  }

  // Solo contactos VERIFICADOS pueden autorizarse a ver la cámara (regla de seguridad del diseño).
  const verifiedContacts = (contactsQuery.data ?? []).filter((c) => c.verified);

  const toggleContact = (contact: TrustedContact): void => {
    if (!shareWithFamily) {
      return; // los contactos solo son togglables con el master encendido.
    }
    setSaved(false);
    setAllowed((prev) => {
      const next = new Set(prev);
      if (next.has(contact.id)) {
        next.delete(contact.id);
      } else {
        next.add(contact.id);
      }
      return next;
    });
  };

  const accentTint = hexAlpha(theme.colors.accent, 0.06);
  const accentBorder = hexAlpha(theme.colors.accent, 0.3);

  return (
    <SafeScreen
      footer={
        <Button
          label={t('cameraControl.save')}
          fullWidth
          loading={saveMutation.isPending}
          onPress={() => saveMutation.mutate()}
        />
      }
    >
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: theme.spacing.md }}>
        <Text variant="callout" color="inkMuted">
          {t('cameraControl.intro')}
        </Text>

        {/* HUECO DE BACKEND · aviso honesto: la preferencia se guarda localmente por ahora. */}
        <Banner tone="info" title={t('cameraControl.backendNotice')} />

        {/* Master toggle: compartir cámara con la familia. */}
        <Card variant="outlined" padding="lg">
          <View style={styles.row}>
            <View style={[styles.lead, { backgroundColor: theme.colors.surfaceElevated, borderRadius: theme.radii.pill }]}>
              <IconCamera color={theme.colors.accent} size={20} />
            </View>
            <View style={styles.flex}>
              <Text variant="bodyStrong">{t('cameraControl.masterTitle')}</Text>
              <Text variant="footnote" color="inkMuted">
                {t('cameraControl.masterSubtitle')}
              </Text>
            </View>
            <Toggle
              on={shareWithFamily}
              accessibilityLabel={t('cameraControl.masterTitle')}
              onChange={(next) => {
                setSaved(false);
                setShareWithFamily(next);
                if (!next) {
                  // Apagar el master desautoriza a todos (coherencia con la regla del repo/usecase).
                  setAllowed(new Set());
                }
              }}
            />
          </View>
        </Card>

        {/* ¿Quién puede ver? · lista de contactos verificados REALES. */}
        <Text variant="subhead" color="inkMuted">
          {t('cameraControl.whoCanView')}
        </Text>
        <Card variant="outlined" padding="md" style={{ opacity: shareWithFamily ? 1 : 0.4 }}>
          {verifiedContacts.length === 0 ? (
            <View style={styles.emptyRow}>
              <Text variant="footnote" color="inkMuted" align="center">
                {t('cameraControl.noVerifiedContacts')}
              </Text>
            </View>
          ) : (
            verifiedContacts.map((contact, index) => (
              <View
                key={contact.id}
                style={[
                  styles.row,
                  styles.contactRow,
                  index > 0 ? { borderTopWidth: 1, borderTopColor: theme.colors.border } : null,
                ]}
              >
                <View style={[styles.lead, { backgroundColor: theme.colors.surfaceElevated, borderRadius: theme.radii.pill }]}>
                  <IconUsers color={theme.colors.ink} size={18} />
                </View>
                <View style={styles.flex}>
                  <Text variant="body">{contact.name}</Text>
                  <Text variant="footnote" color="inkMuted">
                    {`${contact.relationship} · ${t('contacts.verified')}`}
                  </Text>
                </View>
                <Toggle
                  on={allowed.has(contact.id)}
                  disabled={!shareWithFamily}
                  accessibilityLabel={contact.name}
                  onChange={() => toggleContact(contact)}
                />
              </View>
            ))
          )}
        </Card>

        {/* Control parental (card tintada accent). */}
        <Card variant="outlined" padding="lg" style={{ backgroundColor: accentTint, borderColor: accentBorder }}>
          <View style={[styles.row, styles.alignTop]}>
            <IconChild color={theme.colors.accent} size={20} />
            <View style={styles.flex}>
              <Text variant="bodyStrong">{t('cameraControl.parentalTitle')}</Text>
              <Text variant="footnote" color="inkMuted" style={{ marginTop: theme.spacing.xxs }}>
                {t('cameraControl.parentalBody')}
              </Text>
            </View>
          </View>
        </Card>

        {/* Nota de cifrado (footer). */}
        <View style={[styles.row, styles.alignTop, { paddingHorizontal: theme.spacing.xxs }]}>
          <IconLock color={theme.colors.inkSubtle} size={16} />
          <Text variant="footnote" color="inkSubtle" style={styles.flex}>
            {t('cameraControl.encryptionNote')}
          </Text>
        </View>

        {saved ? <Banner tone="success" title={t('cameraControl.saved')} /> : null}
        {saveMutation.isError ? <Banner tone="danger" title={t('cameraControl.saveError')} /> : null}
      </ScrollView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  alignTop: { alignItems: 'flex-start' },
  contactRow: { paddingVertical: 12 },
  emptyRow: { paddingVertical: 16, alignItems: 'center' },
  lead: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
});
