import {ApiError, type RatingView} from '@veo/api-client';
import {useMutation} from '@tanstack/react-query';
import {Banner, Button, Text, TextField, useTheme} from '@veo/ui-kit';
import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {View} from 'react-native';
import {TOKENS} from '../../../../core/di/tokens';
import {useDependency} from '../../../../core/di/useDependency';
import {
  RatingReasonChips,
  reasonLabels,
  type RatingReason,
} from './RatingReasonChips';
import {StarRating} from './StarRating';
import {SuccessCheck} from './motion';

export interface RatingBodyProps {
  tripId: string;
  driverId: string;
  /** Calificación enviada o salteada → el cierre termina (vuelve al home). */
  onDone: () => void;
}

/**
 * Cuerpo de CALIFICACIÓN post-viaje, in-sheet (`POST /ratings`, ratedRole DRIVER). Mismo flujo que la
 * pantalla —estrellas 1-5, motivos, comentario— pero SIN navegación: el rating es SALTEABLE ("Ahora no")
 * y, enviado o no, avisa por `onDone` para cerrar el viaje y volver al home.
 */
export function RatingBody({
  tripId,
  driverId,
  onDone,
}: RatingBodyProps): React.JSX.Element {
  const theme = useTheme();
  const {t} = useTranslation();

  const submitRating = useDependency(TOKENS.submitRatingUseCase);

  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [reasons, setReasons] = useState<RatingReason[]>([]);
  const [touched, setTouched] = useState(false);

  // Al cambiar la nota cambia el set de chips (mejorar ↔ elogios): limpiamos lo elegido para no
  // arrastrar motivos del set anterior.
  const handleStars = (next: number): void => {
    setStars(next);
    setReasons([]);
  };

  const mutation = useMutation<RatingView, Error, void>({
    mutationFn: () => {
      // Hueco de backend: ratingSubmitRequest solo acepta `comment`. Anteponemos los motivos al
      // comentario libre para no perderlos (viajan al backend de forma honesta).
      const tags = reasonLabels(reasons, t);
      const tagLine = tags.length > 0 ? tags.join(' · ') : '';
      const body = [tagLine, comment.trim()].filter(Boolean).join('\n');
      return submitRating.execute({
        tripId,
        ratedId: driverId,
        ratedRole: 'DRIVER',
        stars,
        ...(body ? {comment: body} : {}),
      });
    },
  });

  const submit = (): void => {
    if (stars < 1) {
      setTouched(true);
      return;
    }
    mutation.mutate();
  };

  // 409 = el viaje YA fue calificado (rating idempotente / doble-tap / re-entrada tras cerrar la app).
  // No es un error que mostrar: es el ESTADO de éxito disfrazado. Lo tratamos igual que un envío OK
  // (mensaje "ya calificaste") para que el flujo siga a onDone normal, sin banner rojo confuso.
  const alreadyRated =
    mutation.error instanceof ApiError && mutation.error.status === 409;

  if (mutation.isSuccess || alreadyRated) {
    return (
      <View style={{gap: theme.spacing.md}}>
        <SuccessCheck />
        <Banner
          tone="success"
          title={t(alreadyRated ? 'ratings.alreadyRated' : 'ratings.thanks')}
        />
        {/* Cierre canónico del ciclo (handoff screens-pass): check + "¡Gracias!" + "Volver al inicio".
            La salida se lee como tal —no un genérico "Cerrar"— porque cierra el viaje y devuelve al home. */}
        <Button
          label={t('ratings.backHome')}
          variant="primary"
          fullWidth
          onPress={onDone}
        />
      </View>
    );
  }

  return (
    <View style={{gap: theme.spacing.md}}>
      <Text variant="body" color="inkMuted" align="center">
        {t('ratings.subtitle', {driver: t('trip.driver')})}
      </Text>

      <StarRating value={stars} onChange={handleStars} />

      <RatingReasonChips stars={stars} value={reasons} onChange={setReasons} />

      {touched && stars < 1 ? (
        <Text variant="footnote" color="danger" align="center">
          {t('ratings.selectStars')}
        </Text>
      ) : null}

      {mutation.isError ? (
        <Banner tone="danger" title={t('ratings.error')} />
      ) : null}

      <TextField
        label={t('ratings.commentLabel')}
        placeholder={t('ratings.commentPlaceholder')}
        value={comment}
        onChangeText={setComment}
        multiline
        maxLength={1000}
      />

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
          label={t('ratings.skip')}
          variant="ghost"
          fullWidth
          onPress={onDone}
        />
      </View>
    </View>
  );
}
