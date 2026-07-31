/**
 * Amadeus Self-Service implementation of the FlightProvider contract.
 *
 * Docs: https://developers.amadeus.com/self-service/category/flights
 *
 * Differences from SerpApi that the engine handles transparently:
 *  - OAuth2 client-credentials token, cached in-process until shortly before
 *    it expires.
 *  - No multi-origin support: `supportsMultiOrigin` is false, so the engine
 *    issues one request per origin airport and keeps the cheapest.
 *  - The free "test" environment returns a reduced, cached inventory. Set
 *    AMADEUS_ENV=production once you have production credentials.
 */

import {
  FlightProvider,
  ProviderConfigError,
  QuotaExceededError,
  fetchJson,
} from './flightProvider.js';

const HOSTS = {
  test: 'https://test.api.amadeus.com',
  production: 'https://api.amadeus.com',
};

class AmadeusProvider extends FlightProvider {
  /**
   * @param {{ clientId: string, clientSecret: string, host: string, maxOffers?: number, timeoutMs?: number }} config
   */
  constructor(config) {
    super('amadeus');
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.host = config.host;
    this.maxOffers = config.maxOffers ?? 5;
    this.timeoutMs = config.timeoutMs ?? 30_000;

    /** @type {{ value: string, expiresAt: number }|null} */
    this._token = null;
    /** @type {Promise<string>|null} */
    this._tokenPromise = null;
  }

  /** Amadeus accepts exactly one originLocationCode per request. */
  get supportsMultiOrigin() {
    return false;
  }

  /** Cached OAuth2 token; concurrent callers share a single in-flight request. */
  async _getAccessToken() {
    const now = Date.now();
    if (this._token && this._token.expiresAt > now) return this._token.value;
    if (this._tokenPromise) return this._tokenPromise;

    this._tokenPromise = (async () => {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });

      const payload = await fetchJson(`${this.host}/v1/security/oauth2/token`, {
        provider: this.name,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        timeoutMs: this.timeoutMs,
      });

      if (!payload.access_token) {
        throw new ProviderConfigError('amadeus: token OAuth2 non ricevuto.', {
          provider: this.name,
        });
      }

      // Renew 60s early to avoid using a token that expires mid-flight.
      const ttlMs = Math.max((Number(payload.expires_in) || 1799) - 60, 30) * 1000;
      this._token = { value: payload.access_token, expiresAt: Date.now() + ttlMs };
      return this._token.value;
    })().finally(() => {
      this._tokenPromise = null;
    });

    return this._tokenPromise;
  }

  /**
   * @param {import('./flightProvider.js').SearchRequest} request
   * @returns {Promise<import('./flightProvider.js').FlightQuote|null>}
   */
  async searchRoundTrip(request) {
    const { origins, destination, outboundDate, returnDate, durationDays, currency, adults } =
      request;

    const token = await this._getAccessToken();

    let best = null;

    for (const origin of origins) {
      const params = new URLSearchParams({
        originLocationCode: origin,
        destinationLocationCode: destination,
        departureDate: outboundDate,
        returnDate,
        adults: String(adults),
        currencyCode: currency,
        travelClass: 'ECONOMY',
        max: String(this.maxOffers),
      });

      const payload = await fetchJson(`${this.host}/v2/shopping/flight-offers?${params}`, {
        provider: this.name,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: this.timeoutMs,
      }).catch((error) => {
        // Amadeus reports monthly-quota exhaustion as 429 on the offers route.
        if (error?.status === 429) {
          throw new QuotaExceededError(`amadeus: quota esaurita. ${error.message}`, {
            provider: this.name,
            status: 429,
          });
        }
        throw error;
      });

      const offers = Array.isArray(payload.data) ? payload.data : [];

      for (const offer of offers) {
        const price = Number(offer?.price?.grandTotal ?? offer?.price?.total);
        if (!Number.isFinite(price) || price <= 0) continue;
        if (best && price >= best.price) continue;

        const outboundItinerary = offer.itineraries?.[0];
        const segments = outboundItinerary?.segments ?? [];

        best = {
          price,
          currency: offer?.price?.currency ?? currency,
          origin,
          destination,
          outboundDate,
          returnDate,
          durationDays,
          airlines: [...new Set(segments.map((s) => s.carrierCode).filter(Boolean))],
          stops: segments.length > 0 ? segments.length - 1 : null,
          outboundDurationMinutes: parseIsoDuration(outboundItinerary?.duration),
          bookingUrl: `https://www.google.com/travel/flights?q=${encodeURIComponent(
            `Flights from ${origin} to ${destination} on ${outboundDate} through ${returnDate}`,
          )}`,
          provider: this.name,
        };
      }
    }

    return best;
  }
}

/** "PT14H35M" -> 875 minutes. Returns null for anything unparseable. */
function parseIsoDuration(duration) {
  if (typeof duration !== 'string') return null;
  const match = duration.match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?$/);
  if (!match) return null;
  const [, days, hours, minutes] = match;
  const total = Number(days || 0) * 1440 + Number(hours || 0) * 60 + Number(minutes || 0);
  return total > 0 ? total : null;
}

/**
 * Factory used by `createFlightProvider('amadeus')`.
 * @param {NodeJS.ProcessEnv} env
 */
export function createProvider(env) {
  const clientId = env.AMADEUS_CLIENT_ID;
  const clientSecret = env.AMADEUS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new ProviderConfigError(
      'amadeus: AMADEUS_CLIENT_ID e/o AMADEUS_CLIENT_SECRET mancanti.',
      { provider: 'amadeus' },
    );
  }

  const environment = (env.AMADEUS_ENV || 'test').toLowerCase();
  const host = HOSTS[environment];

  if (!host) {
    throw new ProviderConfigError(
      `amadeus: AMADEUS_ENV non valido ("${environment}"). Usa "test" o "production".`,
      { provider: 'amadeus' },
    );
  }

  return new AmadeusProvider({
    clientId,
    clientSecret,
    host,
    maxOffers: env.AMADEUS_MAX_OFFERS ? Number(env.AMADEUS_MAX_OFFERS) : undefined,
    timeoutMs: env.HTTP_TIMEOUT_MS ? Number(env.HTTP_TIMEOUT_MS) : undefined,
  });
}

export { AmadeusProvider };
