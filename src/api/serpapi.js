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

    const outbound = describeItinerary(cheapest);

    // Diagnostica temporanea: se il prezzo c'è ma orari/scali no, la causa è
    // quasi certamente nella forma di `cheapest.flights`, non nel prezzo.
    // Stampa solo in quel caso per non riempire i log di rumore nel caso comune.
    if (!outbound.departureTime) {
      console.warn(
        `   🩺 [debug] "${destination}": prezzo trovato ma outbound senza orari. ` +
          `flights.length=${Array.isArray(cheapest?.flights) ? cheapest.flights.length : 'n/a'}, ` +
          `chiavi itinerario: ${Object.keys(cheapest ?? {}).join(', ')}` +
          (Array.isArray(cheapest?.flights) && cheapest.flights[0]
            ? `, chiavi flights[0]: ${Object.keys(cheapest.flights[0]).join(', ')}`
            : ''),
      );
    }

    return {
      price: cheapest.price,
      currency,
      origin: outbound.departureAirport ?? origins[0],
      // Gratis: gli itinerari da tutti gli aeroporti richiesti sono già in
      // questa risposta, basta non buttarli via.
      byOrigin: cheapestByOrigin(itineraries, outboundDate, returnDate, destination),
      destination,
      outboundDate,
      returnDate,
      durationDays,
      airlines: outbound.airlines,
      stops: outbound.stops,
      outboundDurationMinutes: outbound.durationMinutes,
      // Orari, scali e compagnie del solo viaggio di andata: con `type=1`
      // Google Flights restituisce le opzioni di andata (il prezzo è comunque
      // quello A/R completo) e i dettagli del ritorno arrivano solo da una
      // seconda chiamata con `departure_token` — cioè raddoppiando il consumo
      // di quota per informazione che non cambia quale volo conviene.
      outbound,
      bookingUrl:
        payload.search_metadata?.google_flights_url ??
        buildGoogleFlightsFallbackUrl(outbound.departureAirport ?? origins[0], destination, outboundDate, returnDate),
      provider: this.name,
    };
  }
}

/**
 * Un itinerario SerpApi → la forma neutra che l'engine e la notifica usano.
 *
 * @param {object} itinerary
 * @returns {import('./flightProvider.js').ItineraryDetails}
 */
function describeItinerary(itinerary) {
  const legs = Array.isArray(itinerary?.flights) ? itinerary.flights : [];
  const first = legs[0] ?? {};
  const last = legs.at(-1) ?? {};

  const layovers = (Array.isArray(itinerary?.layovers) ? itinerary.layovers : []).map((stop) => ({
    airport: stop?.id ?? null,
    durationMinutes: Number.isFinite(stop?.duration) ? stop.duration : null,
    // Uno scalo che scavalca la notte è un'altra cosa rispetto a due ore in
    // aeroporto: cambia se ti serve un hotel, non solo quanto aspetti.
    overnight: Boolean(stop?.overnight),
  }));

  // `total_duration` include già i tempi di scalo; la somma delle tratte no.
  const durationMinutes = Number.isFinite(itinerary?.total_duration)
    ? itinerary.total_duration
    : legs.reduce((sum, leg) => sum + (Number(leg?.duration) || 0), 0) || null;

  return {
    departureAirport: first.departure_airport?.id ?? null,
    departureTime: first.departure_airport?.time ?? null,
    arrivalAirport: last.arrival_airport?.id ?? null,
    arrivalTime: last.arrival_airport?.time ?? null,
    durationMinutes,
    airlines: [...new Set(legs.map((leg) => leg.airline).filter(Boolean))],
    flightNumbers: legs.map((leg) => leg.flight_number).filter(Boolean),
    stops: legs.length > 0 ? legs.length - 1 : null,
    layovers,
  };
}

/**
 * Cheapest itinerary *per departure airport* inside a single response.
 *
 * `departure_id=MXP,BGY,TRN` mixes all three airports in one result list, and
 * `pickCheapest` keeps only the overall winner — which in practice is almost
 * never Torino. Grouping by `flights[0].departure_airport.id` recovers the
 * runner-up airports at zero extra cost.
 *
 * Caveat: Google Flights truncates the list, so an airport whose fares are far
 * above the winner's may simply not appear. A missing entry means "not among
 * the results returned", not "no flights" — the caller must not read it as a
 * price of infinity.
 *
 * @returns {Record<string, { price: number, airlines: string[], stops: number|null, bookingUrl: string|null }>}
 */
function cheapestByOrigin(itineraries, outboundDate, returnDate, destination) {
  /** @type {Record<string, any>} */
  const byOrigin = {};

  for (const itinerary of itineraries) {
    const price = Number(itinerary?.price);
    if (!Number.isFinite(price) || price <= 0) continue;

    const legs = Array.isArray(itinerary.flights) ? itinerary.flights : [];
    const airport = legs[0]?.departure_airport?.id;
    if (!airport) continue;

    if (byOrigin[airport] && byOrigin[airport].price <= price) continue;

    const details = describeItinerary(itinerary);

    byOrigin[airport] = {
      price,
      airlines: details.airlines,
      stops: details.stops,
      durationMinutes: details.durationMinutes,
      outbound: details,
      // Il link globale della risposta punta alla ricerca multi-aeroporto: per
      // un aeroporto specifico serve una query mirata, altrimenti l'utente
      // riapre la stessa ricerca e non ritrova l'offerta annunciata.
      bookingUrl: buildGoogleFlightsFallbackUrl(airport, destination, outboundDate, returnDate),
    };
  }

  return byOrigin;
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
