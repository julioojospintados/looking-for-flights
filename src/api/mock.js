/**
 * Deterministic offline provider — no API key, no network, no quota consumed.
 *
 * Use it to exercise the engine, the ranking and the notification format:
 *   npm run mock
 *   npm run notify-test
 *
 * Prices are derived from a stable hash of the search parameters, so repeated
 * runs with the same config produce identical output (which keeps the delta
 * logic quiet) while different dates/routes produce plausibly varied fares.
 */

import { FlightProvider } from './flightProvider.js';

/** Rough long-haul baselines from Italy, in EUR, used to keep numbers realistic. */
const BASE_PRICES = {
  DEL: 520,
  CGK: 720,
  BKK: 610,
  SGN: 640,
  KUL: 660,
};

const DEFAULT_BASE_PRICE = 700;

class MockProvider extends FlightProvider {
  constructor({ seed = 'looking-for-flights', failureRate = 0 } = {}) {
    super('mock');
    this.seed = seed;
    this.failureRate = failureRate;
  }

  get supportsMultiOrigin() {
    return true;
  }

  /**
   * @param {import('./flightProvider.js').SearchRequest} request
   * @returns {Promise<import('./flightProvider.js').FlightQuote|null>}
   */
  async searchRoundTrip(request) {
    const { origins, destination, outboundDate, returnDate, durationDays, currency } = request;

    const key = `${this.seed}|${origins.join(',')}|${destination}|${outboundDate}|${returnDate}`;
    const noise = hash01(key);

    // Simulate "nessun volo trovato" on a small, deterministic slice of searches.
    if (noise < this.failureRate) return null;

    const base = BASE_PRICES[destination] ?? DEFAULT_BASE_PRICE;
    const spread = base * 0.35; // +/- ~17% around the baseline
    const price = Math.round(base - spread / 2 + noise * spread);

    const origin = origins[Math.floor(hash01(`${key}|origin`) * origins.length)] ?? origins[0];

    return {
      price,
      currency,
      origin,
      destination,
      outboundDate,
      returnDate,
      durationDays,
      airlines: ['MOCK'],
      stops: 1,
      outboundDurationMinutes: 900 + Math.round(hash01(`${key}|dur`) * 300),
      bookingUrl: `https://www.google.com/travel/flights?q=${encodeURIComponent(
        `Flights from ${origin} to ${destination} on ${outboundDate} through ${returnDate}`,
      )}`,
      provider: this.name,
    };
  }
}

/** FNV-1a hash normalised to [0, 1). */
function hash01(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * Factory used by `createFlightProvider('mock')`.
 * @param {NodeJS.ProcessEnv} env
 */
export function createProvider(env) {
  return new MockProvider({
    seed: env.MOCK_SEED || 'looking-for-flights',
    failureRate: env.MOCK_FAILURE_RATE ? Number(env.MOCK_FAILURE_RATE) : 0,
  });
}

export { MockProvider };
