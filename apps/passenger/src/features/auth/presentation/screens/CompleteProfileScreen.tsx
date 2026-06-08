import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Banner,
  BottomSheet,
  Button,
  Card,
  SafeScreen,
  Text,
  TextField,
  useReducedMotion,
  useTheme,
} from '@veo/ui-kit';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Image, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { TOKENS } from '../../../../core/di/tokens';
import { useDependency } from '../../../../core/di/useDependency';
import { useSessionStore } from '../../../../core/session/sessionStore';
import { profileQueryKey } from '../../../profile/presentation/hooks/useProfileCompletion';
import { AvatarUploadError } from '../../../../shared/media/domain/avatarUploader';
import {
  ImagePickError,
  type ImageSource,
  type PickedImage,
} from '../../../../shared/media/domain/imagePickerService';
import { FadeInView, PressableScale } from '../../../../shared/presentation/components/motion';
import { VeoWordmark } from '../../../../shared/presentation/components/VeoWordmark';
import { useProfileLocalStore } from '../stores/profileStore';
import { IconCamera, IconMail, IconPerson, IconShieldCheck } from '../components/icons';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Completar perfil tras el alta (usuario nuevo / sin nombre real, sea por OTP, Apple o Google). El
 * NOMBRE es el único gate (lo que el conductor necesita para saber a quién recoger). Avatar opcional
 * (anillo lima punteado + selector nativo) y correo:
 *  - Si la cuenta YA entregó el correo (Apple/Google → `profile.email`): fila informativa de solo
 *    lectura, no se vuelve a pedir.
 *  - Si NO hay correo: campo OPCIONAL editable (con su porqué).
 *
 * Doctrina de registro mínimo: el DOCUMENTO de identidad NO se pide acá. Su momento es al vincular el
 * pago (`YapeLinkSheet`/perfil), donde se persiste al perfil para el alta de Yape de un toque.
 *
 * Al confirmar hace `PATCH /users/me { name, email? }` (caso de uso real `UpdateProfileUseCase`): el
 * nombre y el correo se persisten en el BACKEND (fuente de verdad). Tras el guardado, marca la
 * bandera local `profile.completed.<userId>` (fast-path de UI) y refresca el perfil cacheado.
 *
 * El `RootNavigator` conmuta al stack principal por estado derivado (no se navega imperativamente):
 * en cuanto el perfil trae `name`/`email` o `markCompleted` marca al usuario, `useProfileCompletion`
 * pasa a `complete`.
 *
 * Avatar (subida REAL): al elegir foto se sube de inmediato vía `UploadAvatarUseCase`
 * (ticket prefirmado del BFF → PUT crudo a MinIO → `PATCH /users/me { photoUrl }`). La pantalla solo
 * dispara el caso de uso: muestra preview optimista + overlay "subiendo", y ante error conserva la
 * foto local para reintentar (rollback de la `photoUrl` remota). La subida del avatar es
 * independiente del guardado de nombre/correo.
 */
export function CompleteProfileScreen(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const reduced = useReducedMotion();

  const updateProfile = useDependency(TOKENS.updateProfileUseCase);
  const getProfile = useDependency(TOKENS.getProfileUseCase);
  const uploadAvatar = useDependency(TOKENS.uploadAvatarUseCase);
  const removeAvatarUseCase = useDependency(TOKENS.removeAvatarUseCase);
  const imagePicker = useDependency(TOKENS.imagePickerService);
  const userId = useSessionStore((state) => state.user?.id ?? null);
  const markCompleted = useProfileLocalStore((state) => state.markCompleted);

  // Perfil real (GET /users/me), MISMA queryKey que `useProfileCompletion` → la caché ya está caliente
  // cuando llegamos acá (el RootNavigator la pobló para decidir el stack). De ahí sale el correo que
  // Apple/Google ya entregaron: si existe, no lo volvemos a pedir.
  const profileQuery = useQuery({
    queryKey: profileQueryKey(userId),
    queryFn: () => getProfile.execute(),
    enabled: Boolean(userId),
  });
  const knownEmail = profileQuery.data?.email?.trim() ? profileQuery.data.email.trim() : null;

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [touched, setTouched] = useState(false);
  // Foto local elegida (preview optimista mientras sube / para reintentar si falla).
  const [pickedFile, setPickedFile] = useState<PickedImage | null>(null);
  const [sourceSheetOpen, setSourceSheetOpen] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const trimmedName = fullName.trim();
  const trimmedEmail = email.trim();
  const nameValid = trimmedName.length >= 2 && trimmedName.length <= 80;
  // El correo editable es OPCIONAL: válido si está vacío o si tiene forma de correo. Si el perfil YA
  // trae correo (Apple/Google) no hay campo editable → no participa de la validación.
  const emailValid = knownEmail !== null || trimmedEmail.length === 0 || EMAIL_PATTERN.test(trimmedEmail);
  // ÚNICO bloqueo del submit: el nombre. El documento NO se pide acá (su momento es al vincular el pago).
  const canSubmit = nameValid && emailValid;

  // Sube el avatar y persiste la `photoUrl` en el perfil (toda la red vive en el caso de uso).
  const avatarMutation = useMutation({
    mutationFn: (file: PickedImage) => uploadAvatar.execute(file),
    onSuccess: (profile) => {
      // Refleja el perfil real (con la nueva `photoUrl`) sin esperar al refetch.
      queryClient.setQueryData(profileQueryKey(userId), profile);
      void queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });

  // URL pública remota una vez subida; null mientras sube / si falla (rollback optimista del valor).
  const uploadedPhotoUrl = avatarMutation.isSuccess ? (avatarMutation.data.photoUrl ?? null) : null;
  const previewUri = uploadedPhotoUrl ?? pickedFile?.uri ?? null;
  const isUploading = avatarMutation.isPending;
  const avatarUploadErrorText = avatarMutation.isError
    ? avatarMutation.error instanceof AvatarUploadError &&
      avatarMutation.error.reason === 'unsupported-type'
      ? t('profileSetup.photoUnsupported')
      : avatarMutation.error instanceof AvatarUploadError &&
          avatarMutation.error.reason === 'too-large'
        ? t('profileSetup.photoTooLarge')
        : t('profileSetup.photoUploadError')
    : null;

  // Microinteracción al elegir avatar: pop sutil de escala + fade (respeta reduce-motion).
  const avatarPop = useSharedValue(1);
  useEffect(() => {
    if (!pickedFile || reduced) {
      avatarPop.value = 1;
      return;
    }
    avatarPop.value = 0.92;
    avatarPop.value = withTiming(1, {
      duration: theme.motion.duration.base,
      easing: Easing.bezier(...theme.motion.easing.standard),
    });
  }, [pickedFile, reduced, avatarPop, theme]);
  const avatarStyle = useAnimatedStyle(() => ({ transform: [{ scale: avatarPop.value }] }));

  // Overlay "subiendo": fade del scrim (solo opacity = GPU; respeta reduce-motion).
  const overlayOpacity = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      overlayOpacity.value = isUploading ? 1 : 0;
      return;
    }
    overlayOpacity.value = withTiming(isUploading ? 1 : 0, {
      duration: isUploading ? theme.motion.duration.base : theme.motion.exit.base,
      easing: Easing.bezier(...theme.motion.easing.standard),
    });
  }, [isUploading, reduced, overlayOpacity, theme]);
  const overlayStyle = useAnimatedStyle(() => ({ opacity: overlayOpacity.value }));

  const submitMutation = useMutation({
    mutationFn: () =>
      // Guardado REAL en backend: nombre (obligatorio) + correo (solo si el usuario lo escribió acá; si
      // ya vino de Apple/Google está persistido y no lo reenviamos). El documento NO va en esta pantalla
      // —su momento es al vincular el pago (YapeLinkSheet/perfil)—. El avatar se persiste por separado en
      // cuanto se sube (ver `avatarMutation`), no en este PATCH.
      updateProfile.execute({
        name: trimmedName,
        ...(!knownEmail && trimmedEmail ? { email: trimmedEmail } : {}),
      }),
    onSuccess: (profile) => {
      // Refleja el perfil real recién guardado para que la completitud conmute sin esperar refetch.
      queryClient.setQueryData(profileQueryKey(userId), profile);
      if (userId) {
        markCompleted(userId);
      }
      void queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });

  const submit = useCallback(() => {
    if (!canSubmit) {
      setTouched(true);
      return;
    }
    submitMutation.mutate();
  }, [canSubmit, submitMutation]);

  const pickFrom = useCallback(
    async (source: ImageSource) => {
      setSourceSheetOpen(false);
      setPickError(null);
      try {
        const picked = await imagePicker.pick(source, { maxWidth: 1024, maxHeight: 1024, quality: 0.8 });
        if (picked) {
          // Preview optimista + subida inmediata (el caso de uso persiste la `photoUrl`).
          setPickedFile(picked);
          avatarMutation.reset();
          avatarMutation.mutate(picked);
        }
      } catch (error) {
        setPickError(
          error instanceof ImagePickError && error.reason === 'permission'
            ? t('profileSetup.photoPermission')
            : t('profileSetup.photoError'),
        );
      }
    },
    [imagePicker, avatarMutation, t],
  );

  const retryUpload = useCallback(() => {
    if (pickedFile) {
      avatarMutation.reset();
      avatarMutation.mutate(pickedFile);
    }
  }, [pickedFile, avatarMutation]);

  const removeAvatar = useCallback(() => {
    // Si la subida YA fue exitosa, la `photoUrl` quedó persistida en el backend (PATCH /users/me).
    // Limpiar solo la UI dejaría la foto huérfana en el servidor: revertimos también en backend
    // (best-effort) antes de limpiar el estado local.
    const wasPersisted = avatarMutation.isSuccess;
    setPickedFile(null);
    avatarMutation.reset();
    setSourceSheetOpen(false);
    if (wasPersisted) {
      void removeAvatarUseCase
        .execute()
        .then((profile) => {
          // Refleja el perfil sin foto sin esperar al refetch.
          queryClient.setQueryData(profileQueryKey(userId), profile);
          void queryClient.invalidateQueries({ queryKey: ['profile'] });
        })
        .catch((error) => {
          // Best-effort: si la reversión remota falla, la UI ya quedó limpia; el usuario puede
          // reintentar quitando/cambiando la foto. No bloqueamos el flujo de completar perfil.
          console.warn('[profile] reversión remota del avatar falló:', error);
        });
    }
  }, [avatarMutation, removeAvatarUseCase, queryClient, userId]);

  return (
    <SafeScreen
      scroll
      footer={
        <Button
          label={t('profileSetup.submit')}
          variant="accent"
          fullWidth
          size="lg"
          loading={submitMutation.isPending}
          disabled={!canSubmit}
          onPress={submit}
        />
      }
    >
      <FadeInView index={0} style={styles.brand}>
        <VeoWordmark size="md" variant="tagline" color="brand" />
      </FadeInView>

      <FadeInView index={1} style={styles.copy}>
        <Text variant="display" align="center">
          {t('profileSetup.title')}
        </Text>
        <Text variant="body" color="inkMuted" align="center" style={styles.subtitle}>
          {t('profileSetup.subtitle')}
        </Text>
      </FadeInView>

      {submitMutation.isError ? (
        <FadeInView index={2}>
          <Banner
            tone="danger"
            title={t('profileSetup.saveError')}
            style={{ marginBottom: theme.spacing.lg }}
          />
        </FadeInView>
      ) : null}

      {/* Avatar opcional: anillo lima punteado + FAB de cámara (abre selector cámara/galería). */}
      <FadeInView index={2} style={styles.avatarWrap}>
        <Animated.View
          style={[
            styles.avatarRing,
            { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface },
            avatarStyle,
          ]}
        >
          {previewUri ? (
            <Image source={{ uri: previewUri }} style={styles.avatarImage} resizeMode="cover" />
          ) : (
            <IconPerson color={theme.colors.inkSubtle} size={72} />
          )}
          {/* Overlay "subiendo": scrim + spinner sobre la foto (solo visible mientras sube). */}
          <Animated.View
            pointerEvents={isUploading ? 'auto' : 'none'}
            accessibilityElementsHidden={!isUploading}
            importantForAccessibility={isUploading ? 'yes' : 'no-hide-descendants'}
            accessibilityLabel={isUploading ? t('profileSetup.photoUploading') : undefined}
            style={[styles.avatarOverlay, { backgroundColor: theme.colors.overlay }, overlayStyle]}
          >
            <ActivityIndicator color={theme.colors.onAccent} />
          </Animated.View>
        </Animated.View>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={t('profileSetup.photoAction')}
          disabled={isUploading}
          onPress={() => {
            setPickError(null);
            setSourceSheetOpen(true);
          }}
          style={styles.cameraFabAnchor}
          contentStyle={[
            styles.cameraFab,
            {
              backgroundColor: theme.colors.accent,
              borderColor: theme.colors.bg,
              opacity: isUploading ? 0.5 : 1,
            },
          ]}
        >
          <IconCamera color={theme.colors.onAccent} holeColor={theme.colors.accent} size={22} />
        </PressableScale>
      </FadeInView>

      {pickError ? (
        <FadeInView index={2} style={styles.pickErrorWrap}>
          <Text variant="footnote" color="danger" align="center">
            {pickError}
          </Text>
        </FadeInView>
      ) : null}

      {avatarUploadErrorText ? (
        <FadeInView index={2} style={styles.uploadErrorWrap}>
          <Text variant="footnote" color="danger" align="center">
            {avatarUploadErrorText}
          </Text>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={t('profileSetup.photoUploadRetry')}
            onPress={retryUpload}
            contentStyle={styles.retryButton}
          >
            <Text variant="footnote" color="accent" align="center">
              {t('profileSetup.photoUploadRetry')}
            </Text>
          </PressableScale>
        </FadeInView>
      ) : null}

      <FadeInView index={3} style={[styles.form, { gap: theme.spacing.lg }]}>
        <TextField
          label={t('profileSetup.nameLabel')}
          placeholder={t('profileSetup.namePlaceholder')}
          value={fullName}
          onChangeText={setFullName}
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          error={touched && !nameValid ? t('profileSetup.invalidName') : undefined}
        />
        {knownEmail ? (
          /* El correo ya lo entregó la cuenta (Apple/Google): fila informativa de solo lectura, no un
             campo deshabilitado. El usuario no tiene NADA que hacer acá salvo escribir su nombre. */
          <Card variant="filled" padding="md">
            <View style={[styles.emailRow, { gap: theme.spacing.md }]}>
              <View
                style={[
                  styles.emailIcon,
                  { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
                ]}
              >
                <IconMail color={theme.colors.inkMuted} size={20} />
              </View>
              <View style={styles.emailText}>
                <Text variant="body" numberOfLines={1}>
                  {knownEmail}
                </Text>
                <Text variant="footnote" color="inkSubtle">
                  {t('profileSetup.emailFromAccount')}
                </Text>
              </View>
            </View>
          </Card>
        ) : (
          <TextField
            label={t('profileSetup.emailLabel')}
            placeholder={t('profileSetup.emailPlaceholder')}
            helperText={t('profileSetup.emailNote')}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="emailAddress"
            error={touched && !emailValid ? t('profileSetup.invalidEmail') : undefined}
          />
        )}
      </FadeInView>

      <FadeInView index={4} style={[styles.privacyRow, { gap: theme.spacing.sm }]}>
        <IconShieldCheck color={theme.colors.inkSubtle} onColor={theme.colors.bg} size={16} />
        <Text variant="footnote" color="inkSubtle" style={styles.privacyText}>
          {t('profileSetup.privacyNote')}
        </Text>
      </FadeInView>

      {/* Selector de origen del avatar (cámara/galería). */}
      <BottomSheet
        visible={sourceSheetOpen}
        onClose={() => setSourceSheetOpen(false)}
        title={t('profileSetup.photoSheetTitle')}
      >
        <View style={{ gap: theme.spacing.sm }}>
          <Button
            label={t('profileSetup.photoFromCamera')}
            variant="primary"
            fullWidth
            onPress={() => void pickFrom('camera')}
          />
          <Button
            label={t('profileSetup.photoFromLibrary')}
            variant="secondary"
            fullWidth
            onPress={() => void pickFrom('library')}
          />
          {pickedFile ? (
            <Button
              label={t('profileSetup.photoRemove')}
              variant="ghost"
              fullWidth
              onPress={removeAvatar}
            />
          ) : null}
        </View>
      </BottomSheet>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  brand: { alignItems: 'center', gap: 2, marginTop: 4, marginBottom: 16 },
  copy: { gap: 8, marginBottom: 24 },
  subtitle: { maxWidth: 320, alignSelf: 'center' },
  avatarWrap: { alignSelf: 'center', marginBottom: 28 },
  avatarRing: {
    width: 132,
    height: 132,
    borderRadius: 66,
    borderWidth: 2,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: { width: '100%', height: '100%', borderRadius: 64 },
  avatarOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 64,
  },
  cameraFabAnchor: { position: 'absolute', right: 0, bottom: 4 },
  cameraFab: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emailRow: { flexDirection: 'row', alignItems: 'center' },
  emailIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emailText: { flex: 1, gap: 2 },
  pickErrorWrap: { marginTop: -16, marginBottom: 20 },
  uploadErrorWrap: { marginTop: -16, marginBottom: 20, gap: 6 },
  retryButton: { paddingVertical: 6, alignItems: 'center' },
  form: {},
  privacyRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 20 },
  privacyText: { flex: 1 },
});
