import type { HttpClient } from '@veo/api-client';
import { openBidView, submitOfferRequest, submittedOfferView } from '@veo/api-client';
import { z } from 'zod';
import type { BiddingRepository, OpenBid, SubmitOfferInput, SubmittedOffer } from '../../domain';

/** Schema de la respuesta del listado: `GET /bids` devuelve un arreglo de `openBidView`. */
const openBidList = z.array(openBidView);

/** Implementación HTTP del `BiddingRepository` contra el driver-bff (ADR 010 §6). */
export class HttpBiddingRepository implements BiddingRepository {
  constructor(private readonly http: HttpClient) {}

  listOpenBids(): Promise<OpenBid[]> {
    return this.http.get('/bids', { schema: openBidList });
  }

  submitOffer(tripId: string, input: SubmitOfferInput): Promise<SubmittedOffer> {
    // Valida el body con el contrato antes de enviarlo (strip de campos no permitidos). El driverId NO
    // viaja: lo deriva el driver-bff de la identidad. El endpoint es POST /bids/:tripId/offer.
    const body = submitOfferRequest.parse(input);
    return this.http.post(`/bids/${tripId}/offer`, { body, schema: submittedOfferView });
  }
}
