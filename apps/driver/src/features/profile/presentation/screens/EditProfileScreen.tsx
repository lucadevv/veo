import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  Avatar,
  Banner,
  BottomSheet,
  Button,
  ListItem,
  SafeScreen,
  Skeleton,
  Text,
  useTheme,
} from '@veo/ui-kit';
import type { RootStackParamList } from '../../../../navigation/types';
import { StateView } from '../../../../shared/presentation/components/StateView';
import { toErrorMessage } from '../../../../shared/presentation/errors';
import { formatPersonName } from '../../../../shared/presentation/format';
import { IconArrowLeft, IconCamera, IconImage } from '../../../../shared/presentation/icons';
import { Reveal } from '../../../../shared/presentation/components/motion';
import { useImagePicker } from '../../../../core/di/useDi';
import {
  ImagePickError,
  type ImageSource,
} from '../../../documents/domain/ports/image-picker-service';
import { AvatarUploadError } from '../../domain';
import { useProfile, useUpdateProfile, useUploadAvatar } from '../hooks/useProfile';
import { ProfileField } from '../components/ProfileField';

type Props = NativeStackScreenProps<RootStackParamList, 'EditProfile'>;

/** Mapea un fallo de selección/subida a la clave i18n de su mensaje accionable. */
function toPhotoErrorKey(err: unknown): string {
  if (err instanceof ImagePickError) {
    if (err.reason === 'permission') return 'profile.edit.photoErrorPermission';
    if (err.reason === 'unavailable') return 'profile.edit.photoErrorUnavailable';
    return 'profile.edit.photoErrorGeneric';
  }
  if (err instanceof AvatarUploadError) {
    switch (err.reason) {
      case 'unsupported-type':
        return 'profile.edit.photoErrorUnsupported';
      case 'too-large':
        return 'profile.edit.photoErrorTooLarge';
      case 'network':
        return 'profile.edit.photoErrorNetwork';
      default:
        return 'profile.edit.photoErrorGeneric';
    }
  }
  return 'profile.edit.photoErrorGeneric';
}

/**
 * Editar perfil (frame `C/Editar-Perfil`). Fiel al diseño: header con retroceso, avatar + chip
 * "Cambiar foto" (ya ACTIVO), los campos Nombre (bloqueado, KYC) / Teléfono / Correo, y el CTA.
 *
 * FOTO DE PERFIL: el chip "Cambiar foto" abre un selector (cámara/galería) → sube el binario con un
 * ticket prefirmado (presign → PUT → confirm). El confirm del driver-bff valida la cuota y PERSISTE la
 * foto en el perfil (identity `User.photoUrl`), así que basta con invalidar el query del perfil para
 * refrescar la vista — no hay PATCH aparte (a diferencia del pasajero).
 *
 * DEGRADACIÓN HONESTA del RESTO de campos: `PATCH /drivers/me/personal` es la única mutación de datos
 * personales y exige legalName+dni+birthDate (que `GET /drivers/me` no devuelve), y no hay endpoint para
 * teléfono ni correo → Nombre/Teléfono/Correo quedan en LECTURA y el guardado deshabilitado con una nota.
 */
export const EditProfileScreen = ({ navigation }: Props): React.JSX.Element => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { data, isLoading, isError, error, refetch } = useProfile();
  // Mutación cableada e invalidando el perfil (lista para un contrato de edición futuro). Hoy el
  // guardado de los datos de contacto está deshabilitado (ningún campo del frame es persistible).
  const update = useUpdateProfile();

  const imagePicker = useImagePicker();
  const uploadAvatar = useUploadAvatar();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const pickAndUpload = async (source: ImageSource): Promise<void> => {
    setSheetOpen(false);
    setPhotoError(null);
    try {
      const file = await imagePicker.pick(source, { maxWidth: 1024, maxHeight: 1024, quality: 0.8 });
      // Cancelar NO es error: el picker devuelve null y no hacemos nada.
      if (!file) return;
      await uploadAvatar.mutateAsync(file);
    } catch (err) {
      setPhotoError(t(toPhotoErrorKey(err)));
    }
  };

  const header = (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
        hitSlop={8}
        onPress={navigation.goBack}
      >
        <IconArrowLeft size={22} color={theme.colors.ink} strokeWidth={2} />
      </Pressable>
      <Text variant="title3" numberOfLines={1}>
        {t('profile.edit.title')}
      </Text>
    </View>
  );

  if (isLoading) {
    return (
      <SafeScreen header={header} scroll>
        <View style={styles.loading}>
          <Skeleton height={84} width={84} radius={theme.radii.pill} />
          <Skeleton height={64} radius={theme.radii.sm} />
          <Skeleton height={64} radius={theme.radii.sm} />
          <Skeleton height={64} radius={theme.radii.sm} />
        </View>
      </SafeScreen>
    );
  }

  if (isError || !data) {
    return (
      <SafeScreen header={header}>
        <StateView
          title={t('errors.generic')}
          description={toErrorMessage(error, t)}
          action={{ label: t('common.retry'), onPress: () => refetch() }}
        />
      </SafeScreen>
    );
  }

  const fullName = formatPersonName(data.fullName);
  const uploading = uploadAvatar.isPending;

  const footer = (
    <View style={styles.footer}>
      <Text variant="caption" color="inkSubtle" align="center">
        {t('profile.edit.unavailable')}
      </Text>
      {/* Fidelidad al frame: el CTA existe, pero deshabilitado (los datos de contacto no son
          persistibles en el contrato actual). `loading` refleja la mutación por si se habilita. */}
      <Button
        label={t('profile.edit.save')}
        variant="primary"
        fullWidth
        disabled
        loading={update.isPending}
      />
    </View>
  );

  return (
    <SafeScreen header={header} footer={footer} scroll>
      <View style={styles.body}>
        <Reveal delay={40}>
          <View style={styles.avatarWrap}>
            <Avatar uri={data.photoUrl ?? undefined} name={fullName ?? undefined} size="xl" />

            {/* "Cambiar foto": abre el selector (cámara/galería). Deshabilitado mientras sube. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('profile.edit.changePhoto')}
              accessibilityState={{ disabled: uploading }}
              disabled={uploading}
              onPress={() => setSheetOpen(true)}
              style={[
                styles.chip,
                {
                  backgroundColor: theme.colors.surfaceElevated,
                  borderRadius: theme.radii.pill,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              {uploading ? (
                <ActivityIndicator size="small" color={theme.colors.brand} />
              ) : (
                <IconCamera size={14} color={theme.colors.brand} strokeWidth={2} />
              )}
              <Text variant="subhead" color="brand">
                {uploading ? t('profile.edit.photoUploading') : t('profile.edit.changePhoto')}
              </Text>
            </Pressable>

            {photoError ? (
              <Banner tone="danger" title={photoError} />
            ) : null}
          </View>
        </Reveal>

        <Reveal delay={90}>
          <View style={styles.fields}>
            <ProfileField label={t('profile.edit.fullName')} value={fullName ?? '—'} locked />
            <ProfileField label={t('profile.edit.phone')} value={data.phone} />
            <ProfileField
              label={t('profile.edit.email')}
              value={t('profile.edit.emailEmpty')}
              muted
            />
          </View>
        </Reveal>
      </View>

      <BottomSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={t('profile.edit.photoSheetTitle')}
      >
        <View style={styles.sheet}>
          <ListItem
            leading={<IconCamera size={20} color={theme.colors.inkMuted} strokeWidth={2} />}
            title={t('profile.edit.photoFromCamera')}
            onPress={() => void pickAndUpload('camera')}
          />
          <ListItem
            leading={<IconImage size={20} color={theme.colors.inkMuted} strokeWidth={2} />}
            title={t('profile.edit.photoFromLibrary')}
            onPress={() => void pickAndUpload('library')}
          />
        </View>
      </BottomSheet>
    </SafeScreen>
  );
};

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  loading: { gap: 16, paddingTop: 16, alignItems: 'stretch' },
  body: { gap: 16, paddingTop: 8 },
  avatarWrap: { alignItems: 'center', gap: 10 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  fields: { gap: 12 },
  footer: { gap: 12 },
  sheet: { gap: 4 },
});
