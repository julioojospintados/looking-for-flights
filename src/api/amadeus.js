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
    /** Miglior offerta per aeroporto: qui è gratis, si interroga un origine per volta. */
    const byOrigin = {};

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

        const outboundItinerary = offer.itineraries?.[0];
        const outbound = describeItinerary(outboundItinerary);
        const bookingUrl = `https://www.google.com/travel/flights?q=${encodeURIComponent(
          `Flights from ${origin} to ${destination} on ${outboundDate} through ${returnDate}`,
        )}`;

        // Il minimo per aeroporto si aggiorna sempre, anche quando questa
        // offerta non batte il record globale: sono due classifiche diverse.
        if (!byOrigin[origin] || price < byOrigin[origin].price) {
          byOrigin[origin] = {
            price,
            airlines: outbound.airlines,
            stops: outbound.stops,
            durationMinutes: outbound.durationMinutes,
            outbound,
            bookingUrl,
          };
        }

        if (best && price >= best.price) continue;

        best = {
          price,
          currency: offer?.price?.currency ?? currency,
          origin,
          destination,
          outboundDate,
          returnDate,
          durationDays,
          airlines: outbound.airlines,
          stops: outbound.stops,
          outboundDurationMinutes: outbound.durationMinutes,
          outbound,
          bookingUrl,
          provider: this.name,
        };
      }
    }

    // `byOrigin` viene allegato al vincitore perché è lì che l'engine lo cerca.
    if (best) best.byOrigin = byOrigin;

    return best;
  }
}

/**
 * Un itinerario Amadeus → la stessa forma neutra prodotta da SerpApi.
 *
 * Amadeus non espone gli scali come oggetti: sono il *buco* fra l'arrivo di
 * una tratta e la partenza della successiva, e vanno calcolati. Qui gli orari
 * sono ISO con offset (`2026-09-15T10:35:00`), quindi la differenza si può
 * fare con Date senza rischio di fusi — a differenza delle stringhe locali
 * che si mostrano poi a schermo.
 *
 * @param {object} itinerary
 * @returns {import('./flightProvider.js').ItineraryDetails}
 */
function describeItinerary(itinerary) {
  const segments = Array.isArray(itinerary?.segments) ? itinerary.segments : [];
  const first = segments[0] ?? {};
  const last = segments.at(-1) ?? {};

  const layovers = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    const arrival = Date.parse(segments[index]?.arrival?.at ?? '');
    const departure = Date.parse(segments[index + 1]?.departure?.at ?? '');
    const durationMinutes =
      Number.isFinite(arrival) && Number.isFinite(departure)
        ? Math.round((departure - arrival) / 60000)
        : null;

    layovers.push({
      airport: segments[index]?.arrival?.iataCode ?? null,
      durationMinutes,
      overnight:
        Number.isFinite(arrival) && Number.isFinite(departure)
          ? new Date(arrival).getUTCDate() !== new Date(departure).getUTCDate()
          : false,
    });
  }

  return {
    departureAirport: first.departure?.iataCode ?? null,
    departureTime: normaliseTime(first.departure?.at),
    arrivalAirport: last.arrival?.iataCode ?? null,
    arrivalTime: normaliseTime(last.arrival?.at),
    durationMinutes: parseIsoDuration(itinerary?.duration),
    airlines: [...new Set(segments.map((segment) => segment.carrierCode).filter(Boolean))],
    flightNumbers: segments
      .map((segment) => [segment.carrierCode, segment.number].filter(Boolean).join(' '))
      .filter(Boolean),
    stops: segments.length > 0 ? segments.length - 1 : null,
    layovers,
  };
}

/** "2026-09-15T10:35:00" -> "2026-09-15 10:35", il formato usato ovunque. */
function normaliseTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(String(value ?? ''));
  return match ? `${match[1]} ${match[2]}` : null;
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
