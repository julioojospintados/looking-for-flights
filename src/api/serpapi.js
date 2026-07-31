/**
 * SerpApi implementation of the FlightProvider contract (Google Flights engine).
 *
 * Docs: https://serpapi.com/google-flights-api
 *
 * Two things worth knowing about this engine:
 *  1. `departure_id` accepts a comma-separated list of airports, so all three
 *     Italian origins cost a single search instead of three. That is the main
 *     reason this is the default provider.
 *  2. With `type=1` (round trip) the API returns the *outbound* options, and
 *     each `price` is already the total round-trip fare — which is exactly the
 *     number we monitor.
 */

import {
  FlightProvider,
  ProviderConfigError,
  ProviderError,
  QuotaExceededError,
  fetchJson,
} from './flightProvider.js';

const ENDPOINT = 'https://serpapi.com/search.json';

/** Substrings SerpApi uses when the account has no searches left. */
const QUOTA_MARKERS = [
  'run out of searches',
  'exceeded your',
  'account limit',
  'plan limit',
  'searches left',
];

/** Substrings that mean "no itinerary", which is a result, not a failure. */
const EMPTY_RESULT_MARKERS = [
  "hasn't returned any results",
  'have not returned any results',
  'no results found',
  'no flights found',
];

class SerpApiProvider extends FlightProvider {
  /**
   * @param {{ apiKey: string, hl?: string, gl?: string, timeoutMs?: number }} config
   */
  constructor(config) {
    super('serpapi');
    this.apiKey = config.apiKey;
    this.hl = config.hl ?? 'it';
    this.gl = config.gl ?? 'it';
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  /** Google Flights accepts "MXP,BGY,TRN" as a single departure_id. */
  get supportsMultiOrigin() {
    return true;
  }

  /**
   * @param {import('./flightProvider.js').SearchRequest} request
   * @returns {Promise<import('./flightProvider.js').FlightQuote|null>}
   */
  async searchRoundTrip(request) {
    const { origins, destination, outboundDate, returnDate, durationDays, currency, adults } =
      request;

    const params = new URLSearchParams({
      engine: 'google_flights',
      api_key: this.apiKey,
      departure_id: origins.join(','),
      arrival_id: destination,
      outbound_date: outboundDate,
      return_date: returnDate,
      currency,
      adults: String(adults),
      type: '1', // 1 = round trip
      travel_class: '1', // economy
      hl: this.hl,
      gl: this.gl,
    });

    const payload = await fetchJson(`${ENDPOINT}?${params.toString()}`, {
      provider: this.name,
      timeoutMs: this.timeoutMs,
    });

    // SerpApi answers HTTP 200 with an `error` field for both "no results" and
    // quota problems, so the body has to be inspected explicitly.
    if (payload.error) {
      const message = String(payload.error);
      const lower = message.toLowerCase();

      if (QUOTA_MARKERS.some((marker) => lower.includes(marker))) {
        throw new QuotaExceededError(`serpapi: quota esaurita. ${message}`, {
          provider: this.name,
        });
      }
      if (EMPTY_RESULT_MARKERS.some((marker) => lower.includes(marker))) {
        return null;
      }
      throw new ProviderError(`serpapi: ${message}`, { provider: this.name });
    }

    const itineraries = [
      ...(Array.isArray(payload.best_flights) ? payload.best_flights : []),
      ...(Array.isArray(payload.other_flights) ? payload.other_flights : []),
    ];

    const cheapest = pickCheapest(itineraries);
    if (!cheapest) return null;

    const legs = Array.isArray(cheapest.flights) ? cheapest.flights : [];
    const firstLeg = legs[0] ?? {};

    return {
      price: cheapest.price,
      currency,
      origin: firstLeg.departure_airport?.id ?? origins[0],
      destination,
      outboundDate,
      returnDate,
      durationDays,
      airlines: [...new Set(legs.map((leg) => leg.airline).filter(Boolean))],
      stops: legs.length > 0 ? legs.length - 1 : null,
      outboundDurationMinutes: Number.isFinite(cheapest.total_duration)
        ? cheapest.total_duration
        : null,
      bookingUrl:
        payload.search_metadata?.google_flights_url ??
        buildGoogleFlightsFallbackUrl(firstLeg.departure_airport?.id ?? origins[0], destination, outboundDate, returnDate),
      provider: this.name,
    };
  }
}

/** Lowest positive numeric price across the returned itineraries. */
function pickCheapest(itineraries) {
  let best = null;
  for (const itinerary of itineraries) {
    const price = Number(itinerary?.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!best || price < Number(best.price)) best = { ...itinerary, price };
  }
  return best;
}

/** Human-usable link when SerpApi does not hand one back. */
function buildGoogleFlightsFallbackUrl(origin, destination, outboundDate, returnDate) {
  const query = `Flights from ${origin} to ${destination} on ${outboundDate} through ${returnDate}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(query)}`;
}

/**
 * Factory used by `createFlightProvider('serpapi')`.
 * @param {NodeJS.ProcessEnv} env
 */
export function createProvider(env) {
  const apiKey = env.SERPAPI_KEY || env.SERPAPI_API_KEY;

  if (!apiKey) {
    throw new ProviderConfigError(
      'serpapi: variabile SERPAPI_KEY mancante. Impostala come GitHub Secret o nel .env locale.',
      { provider: 'serpapi' },
    );
  }

  return new SerpApiProvider({
    apiKey,
    hl: env.SERPAPI_HL,
    gl: env.SERPAPI_GL,
    timeoutMs: env.HTTP_TIMEOUT_MS ? Number(env.HTTP_TIMEOUT_MS) : undefined,
  });
}

export { SerpApiProvider };
