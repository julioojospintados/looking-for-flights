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

  get supportsOneWay() {
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

    // Ogni aeroporto ha il suo prezzo, con un sovrapprezzo deterministico su
    // quelli che non hanno vinto: serve a esercitare il dettaglio per aeroporto
    // (e a far vedere Torino nell'anteprima) senza rete né quota.
    const byOrigin = {};
    for (const airport of origins) {
      // Un aeroporto secondario ogni tanto non compare nei risultati veri: il
      // mock riproduce anche quel caso, altrimenti il ramo "n/d" non si testa.
      if (airport !== origin && hash01(`${key}|${airport}|missing`) < 0.15) continue;

      const surcharge = airport === origin ? 0 : Math.round(20 + hash01(`${key}|${airport}`) * 120);
      const outbound = fakeItinerary(airport, destination, outboundDate, `${key}|${airport}`);

      byOrigin[airport] = {
        price: price + surcharge,
        airlines: outbound.airlines,
        stops: outbound.stops,
        durationMinutes: outbound.durationMinutes,
        outbound,
        bookingUrl: `https://www.google.com/travel/flights?q=${encodeURIComponent(
          `Flights from ${airport} to ${destination} on ${outboundDate} through ${returnDate}`,
        )}`,
      };
    }

    const outbound = byOrigin[origin]?.outbound ?? fakeItinerary(origin, destination, outboundDate, key);

    return {
      price,
      currency,
      origin,
      byOrigin,
      destination,
      outboundDate,
      returnDate,
      durationDays,
      airlines: outbound.airlines,
      stops: outbound.stops,
      outboundDurationMinutes: outbound.durationMinutes,
      outbound,
      bookingUrl: `https://www.google.com/travel/flights?q=${encodeURIComponent(
        `Flights from ${origin} to ${destination} on ${outboundDate} through ${returnDate}`,
      )}`,
      provider: this.name,
    };
  }

  /**
   * @param {{ origins: string[], destination: string, date: string, currency: string, adults: number }} request
   * @returns {Promise<{ byLeg: Record<string, object> }>}
   */
  async searchOneWay(request) {
    const { origins, destination, date } = request;
    // Un one-way arriva anche con `origins=[hub]` e `destination` = lista di
    // aeroporti di casa (per il ritorno): tratto entrambi i lati allo stesso
    // modo, il seed distingue comunque le due direzioni.
    const arrivals = destination.split(',');

    /** @type {Record<string, object>} */
    const byLeg = {};

    for (const origin of origins) {
      for (const arrival of arrivals) {
        if (origin === arrival) continue;

        const key = `${this.seed}|oneway|${origin}>${arrival}|${date}`;
        const noise = hash01(key);
        if (noise < this.failureRate) continue;

        const base = (BASE_PRICES[arrival] ?? BASE_PRICES[origin] ?? DEFAULT_BASE_PRICE) / 2;
        const spread = base * 0.35;
        const price = Math.round(base - spread / 2 + noise * spread);
        const outbound = fakeItinerary(origin, arrival, date, key);

        byLeg[`${origin}>${arrival}`] = {
          price,
          airlines: outbound.airlines,
          stops: outbound.stops,
          durationMinutes: outbound.durationMinutes,
          outbound,
          origin,
          destination: arrival,
        };
      }
    }

    return { byLeg };
  }
}

/** Compagnie e scali plausibili sulle rotte Italia → Asia. */
const FAKE_AIRLINES = ['Qatar Airways', 'Emirates', 'Turkish Airlines', 'Etihad', 'Oman Air'];
const FAKE_HUBS = ['DOH', 'DXB', 'IST', 'AUH', 'MCT'];

/**
 * Itinerario finto ma coerente: orari che tornano con la durata, scalo con la
 * sua attesa, volo che a volte arriva il giorno dopo. Serve a esercitare la
 * formattazione della notifica (durate, scali, giorno successivo) senza rete.
 */
function fakeItinerary(origin, destination, outboundDate, seed) {
  const direct = hash01(`${seed}|direct`) < 0.25;
  const departureMinutes = 6 * 60 + Math.round(hash01(`${seed}|dep`) * 15) * 60;
  const durationMinutes = (direct ? 480 : 780) + Math.round(hash01(`${seed}|dur`) * 300);

  const airline = FAKE_AIRLINES[Math.floor(hash01(`${seed}|air`) * FAKE_AIRLINES.length)];
  const hub = FAKE_HUBS[Math.floor(hash01(`${seed}|hub`) * FAKE_HUBS.length)];
  const layoverMinutes = 60 + Math.round(hash01(`${seed}|lay`) * 300);

  const departure = addMinutes(`${outboundDate} 00:00`, departureMinutes);
  const arrival = addMinutes(departure, durationMinutes);

  return {
    departureAirport: origin,
    departureTime: departure,
    arrivalAirport: destination,
    arrivalTime: arrival,
    durationMinutes,
    airlines: [airline],
    flightNumbers: [`MK ${100 + Math.round(hash01(`${seed}|num`) * 800)}`],
    stops: direct ? 0 : 1,
    layovers: direct
      ? []
      : [{ airport: hub, durationMinutes: layoverMinutes, overnight: layoverMinutes > 300 }],
  };
}

/** "2026-09-15 00:00" + minuti → "2026-09-15 10:35" (UTC, niente fusi nel mock). */
function addMinutes(base, minutes) {
  const [date, time] = String(base).split(' ');
  const start = new Date(`${date}T${time ?? '00:00'}:00Z`);
  const moved = new Date(start.getTime() + minutes * 60000);
  return `${moved.toISOString().slice(0, 10)} ${moved.toISOString().slice(11, 16)}`;
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
