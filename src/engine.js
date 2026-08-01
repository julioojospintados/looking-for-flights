/**
 * Engine: turns a trip configuration into a ranked list of destinations.
 *
 * The engine is deliberately agnostic about *where* prices come from (it only
 * uses the `FlightProvider` contract) and about *how* results are delivered
 * (it returns plain data; `index.js` owns state, deltas and notifications).
 *
 * Economics, per candidate destination:
 *
 *   budgetForGround = budgetTotal - flightPrice - fixedExtra
 *   maxDaysBudget   = floor(budgetForGround / groundCostPerDay)
 *   maxDays         = clamp(maxDaysBudget, 0, tripDuration.max)
 *   totalCost(N)    = flightPrice + fixedExtra + N * groundCostPerDay
 *
 * The trip length is a hard constraint: it must stay within
 * [tripDuration.min, tripDuration.max]. That constraint is enforced twice.
 *
 *  - On the *flight*: the search plan only ever asks for round trips whose
 *    length is inside the window, and any quote that comes back outside it is
 *    discarded (`isDurationAllowed`).
 *  - On the *budget*: `maxDays` is capped at `tripDuration.max`, because days
 *    the budget could pay for but the trip cannot use are not real days.
 *    `maxDaysBudget` keeps the uncapped figure for reference.
 *
 * `maxDays` is the ranking key (descending), with total cost as tie-break.
 * Note that once several destinations can all afford the full trip, they tie on
 * `maxDays` and the ranking is decided entirely by the tie-break.
 */

import { QuotaExceededError } from './api/flightProvider.js';

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Date helpers (UTC only — avoids off-by-one days across timezones/DST)
// ---------------------------------------------------------------------------

/** @param {string} isoDate YYYY-MM-DD */
export function parseDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate).trim());
  if (!match) throw new Error(`Data non valida: "${isoDate}" (formato atteso YYYY-MM-DD).`);
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) throw new Error(`Data non valida: "${isoDate}".`);
  return date;
}

/** @returns {string} YYYY-MM-DD */
export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(isoDate, days) {
  return formatDate(new Date(parseDate(isoDate).getTime() + days * MS_PER_DAY));
}

export function daysBetween(fromIso, toIso) {
  return Math.round((parseDate(toIso).getTime() - parseDate(fromIso).getTime()) / MS_PER_DAY);
}

// ---------------------------------------------------------------------------
// Search plan
// ---------------------------------------------------------------------------

/**
 * Expand the departure window and the accepted trip lengths into the concrete
 * (outbound, return) pairs to query.
 *
 * Every pair costs one API call per destination, so the window is *sampled*
 * with `sampling.departureStrideDays` rather than tested day by day. The first
 * and last day of the window are always included.
 *
 * @param {object} trip
 * @returns {Array<{ outboundDate: string, returnDate: string, durationDays: number }>}
 */
export function buildSearchPlan(trip) {
  const { from, to } = trip.departureWindow;
  const { min, max } = trip.tripDuration;
  const stride = Math.max(1, Number(trip.sampling?.departureStrideDays) || 7);

  const windowDays = daysBetween(from, to);
  if (windowDays < 0) {
    throw new Error(
      `Finestra di partenza non valida per "${trip.id}": "from" (${from}) è dopo "to" (${to}).`,
    );
  }

  const durations = normaliseDurations(trip.sampling?.durationsToTest, min, max, trip.id);

  const departureDates = [];
  for (let offset = 0; offset <= windowDays; offset += stride) {
    departureDates.push(addDays(from, offset));
  }
  if (departureDates.at(-1) !== to) departureDates.push(to);

  const plan = [];
  for (const outboundDate of departureDates) {
    for (const durationDays of durations) {
      plan.push({ outboundDate, returnDate: addDays(outboundDate, durationDays), durationDays });
    }
  }
  return plan;
}

/**
 * Hard constraint on the flight itself: a round trip is acceptable only if the
 * nights between outbound and return fall inside [min, max].
 *
 * The search plan is already built from allowed durations, so this normally
 * passes. It exists because the *provider* is free to return whatever it likes
 * — a different return date, a multi-city rewrite — and an itinerary that does
 * not match the requested window must never reach the ranking.
 *
 * @param {{ outboundDate: string, returnDate: string, durationDays?: number }} quote
 * @param {{ min: number, max: number }} tripDuration
 */
export function isDurationAllowed(quote, tripDuration) {
  const min = Number(tripDuration.min);
  const max = Number(tripDuration.max);

  // Trust the dates over the declared duration: they are what you actually fly.
  let nights;
  try {
    nights = daysBetween(quote.outboundDate, quote.returnDate);
  } catch {
    nights = Number(quote.durationDays);
  }

  if (!Number.isFinite(nights)) return false;
  return nights >= min && nights <= max;
}

/** Keep only durations inside [min, max]; fall back to the extremes. */
function normaliseDurations(requested, min, max, tripId) {
  const candidates = Array.isArray(requested) && requested.length > 0 ? requested : [min, max];

  const valid = [...new Set(candidates.map(Number))]
    .filter((value) => Number.isInteger(value) && value >= min && value <= max)
    .sort((a, b) => a - b);

  if (valid.length === 0) {
    console.warn(
      `⚠️  [${tripId}] Nessuna durata valida in sampling.durationsToTest: uso [${min}, ${max}].`,
    );
    return [...new Set([min, max])];
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Economics
// ---------------------------------------------------------------------------

/**
 * Budget maths for one destination given a flight price.
 *
 * @param {{ price: number }} quote
 * @param {{ groundCostPerDay: number, fixedExtra?: number }} candidate
 * @param {object} trip
 */
export function computeEconomics(quote, candidate, trip) {
  const groundCostPerDay = Number(candidate.groundCostPerDay);
  const fixedExtra = Number(candidate.fixedExtra ?? 0);
  const budgetTotal = Number(trip.budgetTotal);
  const minDays = Number(trip.tripDuration.min);
  const maxTripDays = Number(trip.tripDuration.max);
  const standardDays = Number(trip.tripDuration.standard ?? maxTripDays);

  if (!Number.isFinite(groundCostPerDay) || groundCostPerDay <= 0) {
    throw new Error(
      `Candidato "${candidate.id}": groundCostPerDay deve essere un numero > 0 (valore: ${candidate.groundCostPerDay}).`,
    );
  }

  const budgetForGround = budgetTotal - quote.price - fixedExtra;

  // What the budget alone would pay for, ignoring the length of the trip.
  const maxDaysBudget = Math.max(0, Math.floor(budgetForGround / groundCostPerDay));

  // What you can actually use: the trip cannot exceed tripDuration.max.
  const maxDays = Math.min(maxDaysBudget, maxTripDays);

  const totalCostStandard = round2(quote.price + fixedExtra + standardDays * groundCostPerDay);

  return {
    budgetForGround: round2(budgetForGround),
    maxDays,
    maxDaysBudget,
    // True when the cap is what limits the stay, not the money.
    budgetCoversFullTrip: maxDaysBudget >= maxTripDays,
    minDays,
    maxTripDays,
    standardDays,
    totalCostStandard,
    marginStandard: round2(budgetTotal - totalCostStandard),
    // Feasibility is judged on the uncapped figure: a destination is out only if
    // the budget cannot even cover the *minimum* stay.
    feasible: maxDaysBudget >= minDays,
  };
}

const round2 = (value) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------
// Per-candidate search
// ---------------------------------------------------------------------------

/**
 * Cheapest round trip for one destination across the whole search plan.
 *
 * @param {object} candidate
 * @param {object} trip
 * @param {import('./api/flightProvider.js').FlightProvider} provider
 * @param {{ plan: Array, budget: { remaining: number }, currency: string, adults: number }} context
 */
async function searchCandidate(candidate, trip, provider, context) {
  const { plan, budget, currency, adults } = context;

  let best = null;
  const errors = [];
  let searched = 0;
  let skippedForBudget = 0;
  let rejectedForDuration = 0;

  for (const slot of plan) {
    if (budget.remaining <= 0) {
      skippedForBudget += 1;
      continue;
    }
    budget.remaining -= 1;
    searched += 1;

    try {
      const quote = await provider.searchRoundTrip({
        origins: trip.origins,
        destination: candidate.hub,
        outboundDate: slot.outboundDate,
        returnDate: slot.returnDate,
        durationDays: slot.durationDays,
        currency,
        adults,
      });

      if (!quote) continue;

      // Enforce the trip-length constraint on what actually came back.
      if (!isDurationAllowed(quote, trip.tripDuration)) {
        rejectedForDuration += 1;
        console.warn(
          `   ⚠️  ${candidate.hub} ${quote.outboundDate}→${quote.returnDate}: durata fuori ` +
            `dai limiti ${trip.tripDuration.min}-${trip.tripDuration.max} giorni, scartato`,
        );
        continue;
      }

      if (!best || quote.price < best.price) best = quote;
    } catch (error) {
      // Quota exhaustion is fatal for the run: bubble it up immediately.
      if (error instanceof QuotaExceededError) throw error;

      errors.push(`${slot.outboundDate}→${slot.returnDate}: ${error.message}`);
      console.warn(`   ⚠️  ${candidate.hub} ${slot.outboundDate}→${slot.returnDate}: ${error.message}`);
    }
  }

  return { best, errors, searched, skippedForBudget, rejectedForDuration };
}

// ---------------------------------------------------------------------------
// Trip run
// ---------------------------------------------------------------------------

/**
 * Price every candidate of a trip and rank them.
 *
 * Candidates are processed with bounded concurrency; a candidate that fails or
 * finds nothing is still reported (with `status`), it is just excluded from the
 * ranking. Quota exhaustion stops the run and is reported on the result.
 *
 * @param {object} trip
 * @param {import('./api/flightProvider.js').FlightProvider} provider
 * @returns {Promise<object>} Trip result, ready to be diffed and rendered.
 */
export async function runTrip(trip, provider) {
  validateTrip(trip);

  const currency = trip.currency ?? 'EUR';
  const adults = Number(trip.adults ?? 1);
  const plan = buildSearchPlan(trip);

  const maxCalls = Number(trip.sampling?.maxApiCallsPerRun) || plan.length * trip.candidates.length;
  const concurrency = Math.max(1, Number(trip.sampling?.concurrency) || 3);
  const budget = { remaining: maxCalls };

  console.log(
    `🔎 [${trip.id}] ${trip.candidates.length} destinazioni × ${plan.length} combinazioni date ` +
      `= ${trip.candidates.length * plan.length} ricerche (tetto: ${maxCalls}, provider: ${provider.name})`,
  );

  let quotaExhausted = null;

  const results = await mapWithConcurrency(trip.candidates, concurrency, async (candidate) => {
    // Once the quota is gone, stop issuing calls but keep the candidate listed.
    if (quotaExhausted) {
      return {
        id: candidate.id,
        name: candidate.name,
        hub: candidate.hub,
        groundCostPerDay: candidate.groundCostPerDay,
        fixedExtra: Number(candidate.fixedExtra ?? 0),
        status: 'quota_exceeded',
        error: quotaExhausted.message,
        price: null,
        maxDays: null,
        totalCostStandard: null,
      };
    }

    try {
      const { best, errors, searched, skippedForBudget, rejectedForDuration } =
        await searchCandidate(candidate, trip, provider, { plan, budget, currency, adults });

      const base = {
        id: candidate.id,
        name: candidate.name,
        hub: candidate.hub,
        groundCostPerDay: Number(candidate.groundCostPerDay),
        fixedExtra: Number(candidate.fixedExtra ?? 0),
        notes: candidate.notes ?? null,
        searchesUsed: searched,
        searchesSkipped: skippedForBudget,
        rejectedForDuration,
        warnings: errors,
      };

      if (!best) {
        const motivo =
          rejectedForDuration > 0
            ? `nessun volo entro ${trip.tripDuration.min}-${trip.tripDuration.max} giorni ` +
              `(${rejectedForDuration} scartati per durata)`
            : 'nessun volo trovato';

        console.log(`   ❌ ${candidate.name} (${candidate.hub}): ${motivo}`);
        return {
          ...base,
          status: errors.length > 0 ? 'error' : 'no_flights',
          error: errors[0] ?? (rejectedForDuration > 0 ? motivo : null),
          price: null,
          maxDays: null,
          totalCostStandard: null,
        };
      }

      const economics = computeEconomics(best, candidate, trip);

      // Deliberately never logs economics.maxDaysBudget: on a public repo, CI
      // logs are public too, and that uncapped figure combined with the
      // (public) groundCostPerDay and the price just printed would let anyone
      // reverse-engineer the private trip budget.
      console.log(
        `   ✅ ${candidate.name} (${candidate.hub}): ${best.price} ${currency} ` +
          `da ${best.origin} · ${best.outboundDate}→${best.returnDate} · ` +
          `${economics.maxDays}/${economics.maxTripDays} gg`,
      );

      return {
        ...base,
        status: 'ok',
        price: round2(best.price),
        currency: best.currency ?? currency,
        origin: best.origin,
        outboundDate: best.outboundDate,
        returnDate: best.returnDate,
        durationDays: best.durationDays,
        airlines: best.airlines ?? [],
        stops: best.stops ?? null,
        bookingUrl: best.bookingUrl ?? null,
        ...economics,
      };
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        quotaExhausted = error;
        console.error(`   🚫 Quota API esaurita durante "${candidate.name}": ${error.message}`);
      } else {
        console.error(`   ❌ ${candidate.name}: ${error.message}`);
      }

      return {
        id: candidate.id,
        name: candidate.name,
        hub: candidate.hub,
        groundCostPerDay: Number(candidate.groundCostPerDay),
        fixedExtra: Number(candidate.fixedExtra ?? 0),
        status: error instanceof QuotaExceededError ? 'quota_exceeded' : 'error',
        error: error.message,
        price: null,
        maxDays: null,
        totalCostStandard: null,
      };
    }
  });

  const ranked = rankResults(results);

  return {
    tripId: trip.id,
    tripName: trip.name,
    provider: provider.name,
    currency,
    budgetTotal: Number(trip.budgetTotal),
    departureWindow: { ...trip.departureWindow },
    tripDuration: { ...trip.tripDuration },
    origins: [...trip.origins],
    generatedAt: new Date().toISOString(),
    apiCallsUsed: maxCalls - budget.remaining,
    apiCallsBudget: maxCalls,
    quotaExhausted: Boolean(quotaExhausted),
    results: ranked,
  };
}

/**
 * Rank by max sustainable days (desc). Ties break on total cost for the
 * standard trip (asc). Candidates without a price go last, in config order.
 */
export function rankResults(results) {
  const priced = results.filter((r) => r.status === 'ok');
  const unpriced = results.filter((r) => r.status !== 'ok');

  priced.sort((a, b) => {
    if (b.maxDays !== a.maxDays) return b.maxDays - a.maxDays;
    return a.totalCostStandard - b.totalCostStandard;
  });

  return [
    ...priced.map((result, index) => ({ ...result, rank: index + 1 })),
    ...unpriced.map((result) => ({ ...result, rank: null })),
  ];
}

// ---------------------------------------------------------------------------
// Validation & concurrency
// ---------------------------------------------------------------------------

/** Fail fast on a malformed trip rather than sending garbage to the API. */
export function validateTrip(trip) {
  const errors = [];

  if (!trip.id) errors.push('manca "id"');
  if (!Number.isFinite(Number(trip.budgetTotal)) || Number(trip.budgetTotal) <= 0) {
    errors.push('"budgetTotal" deve essere un numero > 0');
  }
  if (!Array.isArray(trip.origins) || trip.origins.length === 0) {
    errors.push('"origins" deve contenere almeno un codice IATA');
  }
  if (!Array.isArray(trip.candidates) || trip.candidates.length === 0) {
    errors.push('"candidates" deve contenere almeno una destinazione');
  }
  if (!trip.departureWindow?.from || !trip.departureWindow?.to) {
    errors.push('"departureWindow.from" e "departureWindow.to" sono obbligatori');
  }
  if (!trip.tripDuration?.min || !trip.tripDuration?.max) {
    errors.push('"tripDuration.min" e "tripDuration.max" sono obbligatori');
  } else if (Number(trip.tripDuration.min) > Number(trip.tripDuration.max)) {
    errors.push('"tripDuration.min" non può superare "tripDuration.max"');
  }

  for (const candidate of trip.candidates ?? []) {
    if (!candidate.id) errors.push(`una destinazione non ha "id"`);
    if (!candidate.hub) errors.push(`destinazione "${candidate.id}": manca "hub"`);
    if (!Number.isFinite(Number(candidate.groundCostPerDay))) {
      errors.push(`destinazione "${candidate.id}": "groundCostPerDay" non valido`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configurazione viaggio non valida (${trip.id ?? '?'}):\n  - ${errors.join('\n  - ')}`);
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return output;
}
