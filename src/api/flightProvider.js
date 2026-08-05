/**
 * Generic flight-provider contract.
 *
 * The engine never talks to a vendor SDK directly: it only depends on the
 * `FlightProvider` shape defined here. Swapping SerpApi for Amadeus (or any
 * future source) means adding one file under `src/api/` and registering it in
 * `PROVIDERS` below — no change to `engine.js` or `index.js`.
 *
 * @typedef {Object} SearchRequest
 * @property {string[]} origins       IATA codes of acceptable departure airports.
 * @property {string}   destination   IATA code of the arrival hub.
 * @property {string}   outboundDate  ISO date (YYYY-MM-DD).
 * @property {string}   returnDate    ISO date (YYYY-MM-DD).
 * @property {number}   durationDays  Nights between outbound and return.
 * @property {string}   currency      ISO 4217 code, e.g. "EUR".
 * @property {number}   adults        Number of adult passengers.
 *
 * @typedef {Object} Layover
 * @property {string|null} airport          IATA dello scalo.
 * @property {number|null} durationMinutes  Attesa a terra.
 * @property {boolean}     overnight        Scalo che scavalca la notte.
 *
 * @typedef {Object} ItineraryDetails
 * Dettagli del viaggio di **andata**: orari locali all'aeroporto (stringhe,
 * non Date — vedi `formatDateTime`), durata porta a porta, scali e compagnie.
 * @property {string|null} departureAirport
 * @property {string|null} departureTime    "YYYY-MM-DD HH:MM", ora locale.
 * @property {string|null} arrivalAirport
 * @property {string|null} arrivalTime      "YYYY-MM-DD HH:MM", ora locale.
 * @property {number|null} durationMinutes  Scali inclusi.
 * @property {string[]}    airlines
 * @property {string[]}    flightNumbers
 * @property {number|null} stops
 * @property {Layover[]}   layovers
 *
 * @typedef {Object} OriginOffer
 * @property {number}      price
 * @property {string[]}    [airlines]
 * @property {number|null} [stops]
 * @property {number|null} [durationMinutes]
 * @property {ItineraryDetails} [outbound]
 * @property {string|null} [bookingUrl]
 *
 * @typedef {Object} FlightQuote
 * @property {number}      price                    Total round-trip price for all passengers.
 * @property {string}      currency
 * @property {string}      origin                   IATA code actually used.
 * @property {Record<string, OriginOffer>} [byOrigin]  Cheapest fare *per departure
 *   airport* for this same date pair. Optional: providers that cannot break the
 *   result down omit it and the engine falls back to `origin`/`price` alone.
 *   It exists because `origin` only names the winning airport — with a
 *   multi-origin search the other airports are priced in the very same
 *   response, and throwing them away would mean paying a second API call to
 *   learn what the first one already knew.
 * @property {string}      destination
 * @property {string}      outboundDate
 * @property {string}      returnDate
 * @property {number}      durationDays
 * @property {string[]}    airlines
 * @property {number|null} stops                    Stops on the outbound leg.
 * @property {number|null} outboundDurationMinutes
 * @property {ItineraryDetails} [outbound]          Orari, scali e compagnie dell'andata.
 * @property {string|null} bookingUrl
 * @property {string}      provider
 */

/** Base class for every recoverable provider failure. */
export class ProviderError extends Error {
  constructor(message, { provider, cause, status } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status ?? null;
    if (cause) this.cause = cause;
  }
}

/**
 * The API refused the call because the account is out of credits or rate
 * limited. The engine treats this as fatal for the whole run: retrying other
 * destinations would only burn more failed calls.
 */
export class QuotaExceededError extends ProviderError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'QuotaExceededError';
  }
}

/** Missing/invalid credentials or unusable configuration. */
export class ProviderConfigError extends ProviderError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'ProviderConfigError';
  }
}

/**
 * Interface every provider implementation extends.
 * @abstract
 */
export class FlightProvider {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
  }

  /**
   * True when the provider can evaluate several origin airports in a single
   * request. The engine uses this to decide whether to fan out over origins.
   * @returns {boolean}
   */
  get supportsMultiOrigin() {
    return false;
  }

  /**
   * Cheapest round trip for the given request, or `null` when the provider
   * returned no usable itinerary (a normal outcome, not an error).
   * @param {SearchRequest} _request
   * @returns {Promise<FlightQuote|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async searchRoundTrip(_request) {
    throw new Error(`${this.name}: searchRoundTrip() not implemented`);
  }
}

/**
 * Registry of known providers. Values are lazy loaders so that importing this
 * module never pulls in credentials-checking code for providers you don't use.
 */
const PROVIDERS = {
  serpapi: () => import('./serpapi.js'),
  amadeus: () => import('./amadeus.js'),
  mock: () => import('./mock.js'),
};

export function listProviders() {
  return Object.keys(PROVIDERS);
}

/**
 * Instantiate a provider by name.
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<FlightProvider>}
 */
export async function createFlightProvider(name, env = process.env) {
  const key = String(name || '').toLowerCase().trim();
  const loader = PROVIDERS[key];

  if (!loader) {
    throw new ProviderConfigError(
      `Provider sconosciuto: "${name}". Disponibili: ${listProviders().join(', ')}.`,
      { provider: key },
    );
  }

  const module = await loader();
  return module.createProvider(env);
}

// ---------------------------------------------------------------------------
// Shared HTTP helper
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * JSON fetch with timeout, bounded exponential backoff and honest error typing.
 * Retries only on transient failures; a 429 that survives every attempt is
 * surfaced as `QuotaExceededError` so the run can stop early.
 *
 * @param {string} url
 * @param {{
 *   provider: string,
 *   method?: string,
 *   headers?: Record<string,string>,
 *   body?: string,
 *   retries?: number,
 *   timeoutMs?: number,
 *   baseDelayMs?: number,
 * }} options
 * @returns {Promise<any>} Parsed JSON body.
 */
export async function fetchJson(url, options) {
  const {
    provider,
    method = 'GET',
    headers = {},
    body,
    retries = 3,
    timeoutMs = 30_000,
    baseDelayMs = 1_000,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal });
      const text = await response.text();

      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (response.ok) {
        if (parsed === null) {
          throw new ProviderError(`${provider}: risposta non JSON (HTTP ${response.status}).`, {
            provider,
            status: response.status,
          });
        }
        return parsed;
      }

      const detail = extractErrorMessage(parsed) || text.slice(0, 200) || response.statusText;

      if (response.status === 401 || response.status === 403) {
        throw new ProviderConfigError(
          `${provider}: credenziali rifiutate (HTTP ${response.status}). ${detail}`,
          { provider, status: response.status },
        );
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < retries) {
        lastError = new ProviderError(`${provider}: HTTP ${response.status}. ${detail}`, {
          provider,
          status: response.status,
        });
        await sleep(backoffDelay(baseDelayMs, attempt, response.headers.get('retry-after')));
        continue;
      }

      if (response.status === 429) {
        throw new QuotaExceededError(
          `${provider}: quota/rate limit esaurita (HTTP 429). ${detail}`,
          { provider, status: response.status },
        );
      }

      throw new ProviderError(`${provider}: HTTP ${response.status}. ${detail}`, {
        provider,
        status: response.status,
      });
    } catch (error) {
      // Never retry errors we deliberately classified as terminal.
      if (error instanceof QuotaExceededError || error instanceof ProviderConfigError) throw error;
      if (error instanceof ProviderError && !RETRYABLE_STATUS.has(error.status)) throw error;

      lastError = error;
      if (attempt >= retries) break;
      await sleep(backoffDelay(baseDelayMs, attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  const isAbort = lastError?.name === 'AbortError';
  throw new ProviderError(
    isAbort
      ? `${provider}: timeout dopo ${timeoutMs}ms.`
      : `${provider}: richiesta fallita dopo ${retries + 1} tentativi. ${lastError?.message ?? ''}`.trim(),
    { provider, cause: lastError },
  );
}

/** Exponential backoff with jitter, capped at 20s; honours `Retry-After`. */
function backoffDelay(baseDelayMs, attempt, retryAfterHeader) {
  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 60_000);
  }
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponential + jitter, 20_000);
}

/** Digs a human-readable message out of the varied error shapes APIs return. */
function extractErrorMessage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.error === 'string') return payload.error;
  if (typeof payload.error?.message === 'string') return payload.error.message;
  if (typeof payload.message === 'string') return payload.message;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    return [first.title, first.detail].filter(Boolean).join(' - ') || null;
  }
  return null;
}
