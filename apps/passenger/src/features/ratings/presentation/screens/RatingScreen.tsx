import {ApiError, type RatingView} from '@veo/api-client';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import {useMutation} from '@tanstack/react-query';
import {
  Banner,
  Button,
  SafeScreen,
  Text,
  TextField,
  useTheme,
} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ScrollView, View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {TipCard} from '../../../payments/presentation';
import type {RootStackParamList} from '../../../../navigation/types';
import {
  RatingReasonChips,
  reasonLabels,
  type RatingReason,
} from '../components/RatingReasonChips';
import {StarRating} from '../components/StarRating';
import {SuccessCheck} from '../components/motion';

type Params = RouteProp<RootStackParamList, 'Rating'>;

/**
 * Calificación post-viaje del conductor (`POST /ratings`, ratedRole DRIVER). Estrellas 1-5 y
 * comentario opcional. Al enviar, agradece y cierra.
 */
export function RatingScreen(): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();
  const navigation = useNavigation();
  const {params} = useRoute<Params>();

  const submitRating = useDependency(TOKENS.submitRatingUseCase);

  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [reasons, setReasons] = useState<RatingReason[]>([]);
  const [touched, setTouched] = useState(false);

  // Al cambiar la nota cambia el set de chips (mejorar ↔ elogios): limpiamos lo elegido para no
  // arrastrar motivos del set anterior (p.ej. "Cobró de más" si el usuario sube a 5 estrellas).
  const handleStars = (next: number): void => {
    setStars(next);
    setReasons([]);
  };

  const mutation = useMutation<RatingView, Error, void>({
    mutationFn: () => {
      // Hueco de backend: ratingSubmitRequest solo acepta `comment` (sin tags estructurados). Para no
      // perder los motivos elegidos, los anteponemos al comentario libre — viajan al backend de forma honesta.
      // DEUDA: (backend) el POST de ratings solo acepta 'comment'; los motivos (chips) se anteponen al texto libre en vez de ir como tags[] estructurados. Pedir al backend aceptar tags[] para analítica real de motivos.
      const tags = reasonLabels(reasons, t);
      const tagLine = tags.length > 0 ? tags.join(' · ') : '';
      const body = [tagLine, comment.trim()].filter(Boolean).join('\n');
      return submitRating.execute({
        tripId: params.tripId,
        ratedId: params.driverId,
        ratedRole: 'DRIVER',
        stars,
        ...(body ? {comment: body} : {}),
      });
    },
  });

  const submit = () => {
    if (stars < 1) {
      setTouched(true);
      return;
    }
    mutation.mutate();
  };

  // 409 = el viaje YA fue calificado (idempotente / re-entrada / doble-tap). No es un error que
  // mostrar: es éxito disfrazado. Lo tratamos igual que un envío OK (mensaje "ya calificaste"), igual
  // que el `RatingBody` canónico, para que esta pantalla sea coherente y no muestre un banner rojo.
  const alreadyRated =
    mutation.error instanceof ApiError && mutation.error.status === 409;

  if (mutation.isSuccess || alreadyRated) {
    return (
      <SafeScreen
        footer={
          <Button
            label={t('actions.close')}
            fullWidth
            onPress={() => navigation.goBack()}
          />
        }>
        <ScrollView
          contentContainerStyle={{
            gap: theme.spacing.lg,
            paddingBottom: theme.spacing.xl,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          <SuccessCheck />
          <Banner
            tone="success"
            title={t(alreadyRated ? 'ratings.alreadyRated' : 'ratings.thanks')}
          />
          {/* Tras calificar, ofrece dejar propina al conductor (100% para él). */}
          <TipCard tripId={params.tripId} />
        </ScrollView>
      </SafeScreen>
    );
  }

  return (
    <SafeScreen
      footer={
        <View style={{gap: theme.spacing.sm}}>
          <Button
            label={
              mutation.isPending ? t('ratings.submitting') : t('ratings.submit')
            }
            fullWidth
            loading={mutation.isPending}
            onPress={submit}
          />
          <Button
            label={t('actions.skip')}
            variant="ghost"
            fullWidth
            onPress={() => navigation.goBack()}
          />
        </View>
      }>
      <Text
        variant="body"
        color="inkMuted"
        align="center"
        style={{marginBottom: theme.spacing.xl}}>
        {t('ratings.subtitle', {driver: t('trip.driver')})}
      </Text>

      <StarRating value={stars} onChange={handleStars} />

      <RatingReasonChips stars={stars} value={reasons} onChange={setReasons} />

      {touched && stars < 1 ? (
        <Text
          variant="footnote"
          color="danger"
          align="center"
          style={{marginTop: theme.spacing.sm}}>
          {t('ratings.selectStars')}
        </Text>
      ) : null}

      {mutation.isError ? (
        <Banner
          tone="danger"
          title={t('ratings.error')}
          style={{marginTop: theme.spacing.lg}}
        />
      ) : null}

      <View style={{marginTop: theme.spacing.xl}}>
        <TextField
          label={t('ratings.commentLabel')}
          placeholder={t('ratings.commentPlaceholder')}
          value={comment}
          onChangeText={setComment}
          multiline
          maxLength={1000}
        />
      </View>
    </SafeScreen>
  );
}
