import {useQuery} from '@tanstack/react-query';
import {useTranslation} from 'react-i18next';
import {TOKENS} from '../../../core/di/tokens';
import {useDependency} from '../../../core/di/useDependency';

/**
 * Etiqueta legible de un punto vía geocoding inverso REAL (query key `['maps','reverse',…]`
 * compartida app-wide: cache por coordenada, sin inventar direcciones — mientras carga o si
 * el geocoder no responde, cae al genérico "punto en el mapa").
 */
export function usePlaceLabel(lat: number, lon: number): string {
  const {t} = useTranslation();
  const reverseGeocode = useDependency(TOKENS.reverseGeocodeUseCase);
  const labelQuery = useQuery({
    queryKey: ['maps', 'reverse', lat, lon],
    queryFn: () => reverseGeocode.execute({lat, lng: lon}),
    staleTime: 5 * 60_000,
  });
  return labelQuery.data?.title ?? t('home.selectedOnMap');
}
