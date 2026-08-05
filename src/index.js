#!/usr/bin/env node
/**
 * Entry point.
 *
 * Responsibilities, in order:
 *   1. Load `config/trips.json` and build the configured flight provider.
 *   2. Run the engine for every enabled trip.
 *   3. Diff the fresh ranking against `data/last_prices.json`.
 *   4. Notify only when the diff says it is worth it.
 *   5. Persist the new snapshot when anything actually changed.
 *
 * CLI flags:
 *   --dry-run            do not write state, do not send notifications
 *   --force-notify       send the notification regardless of the delta rules
 *   --provider=<name>    override config/env provider (serpapi|amadeus|mock)
 *   --config=<path>      alternative config file
 *   --state=<path>       alternative state file
 *   --trip=<id>          run a single trip by id
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFlightProvider, ProviderConfigError } from './api/flightProvider.js';
import { runTrip } from './engine.js';
import { airportCity, airportLabel, airportListLabel } from './utils/airports.js';
import {
  formatDateTime,
  formatDay,
  formatDuration,
  formatPrice,
  renderTable,
  truncate,
} from './utils/format.js';
import { availableChannels, escapeHtml, sendNotification } from './utils/notifier.js';
import {
  emptyQuotaState,
  nextReleaseDate,
  recordUsage,
  remainingAllowance,
  today,
  usageInWindow,
} from './utils/quota.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_VERSION = 1;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    dryRun: false,
    forceNotify: false,
    provider: null,
    configPath: path.join(ROOT, 'config', 'trips.json'),
    statePath: path.join(ROOT, 'data', 'last_prices.json'),
    tripId: null,
    budgetOverride: null,
  };

  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force-notify') args.forceNotify = true;
    else if (arg.startsWith('--provider=')) args.provider = arg.slice('--provider='.length);
    else if (arg.startsWith('--config=')) args.configPath = path.resolve(arg.slice('--config='.length));
    else if (arg.startsWith('--state=')) args.statePath = path.resolve(arg.slice('--state='.length));
    else if (arg.startsWith('--trip=')) args.tripId = arg.slice('--trip='.length);
    // Test-only convenience: lets `npm run mock` work with zero setup, without
    // touching the BUDGET_<TRIP_ID> mechanism used for the real, private value.
    else if (arg.startsWith('--budget=')) args.budgetOverride = Number(arg.slice('--budget='.length));
    else console.warn(`⚠️  Argomento ignorato: ${arg}`);
  }

  // GitHub Actions passes booleans as strings via workflow_dispatch inputs.
  if (process.env.FORCE_NOTIFY === 'true') args.forceNotify = true;
  if (process.env.DRY_RUN === 'true') args.dryRun = true;

  return args;
}

// ---------------------------------------------------------------------------
// Config & state I/O
// ---------------------------------------------------------------------------

async function loadConfig(configPath, env = process.env) {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`File di configurazione non trovato: ${configPath}`);
    throw error;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`JSON non valido in ${configPath}: ${error.message}`);
  }

  if (!Array.isArray(config.trips) || config.trips.length === 0) {
    throw new Error(`${configPath}: "trips" deve essere un array non vuoto.`);
  }

  const defaults = config.defaults ?? {};

  // Merge defaults into each trip so the engine always sees a complete object.
  config.trips = config.trips.map((trip) => ({
    ...trip,
    currency: trip.currency ?? defaults.currency ?? 'EUR',
    adults: trip.adults ?? defaults.adults ?? 1,
    notify: { ...(defaults.notify ?? {}), ...(trip.notify ?? {}) },
    budgetTotal: readBudgetOverride(trip, env) ?? trip.budgetTotal,
  }));

  config.defaults = defaults;
  return config;
}

/**
 * Env var name carrying a trip's private budget: `BUDGET_<TRIP_ID>`, uppercased
 * with non-alphanumerics turned into underscores — e.g. trip id
 * "asia-autunno-2026" -> `BUDGET_ASIA_AUTUNNO_2026`.
 * @param {string} tripId
 */
function budgetEnvVarName(tripId) {
  return `BUDGET_${String(tripId).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * The trip budget is treated as private: it is never committed to
 * config/trips.json, only supplied at runtime via an environment variable (a
 * GitHub Secret in CI, a local .env otherwise). This keeps the config file
 * itself safe to publish — anyone forking the repo sets their own budget
 * without touching code, the same way API keys already work.
 *
 * @param {{ id: string }} trip
 * @param {NodeJS.ProcessEnv} env
 * @returns {number|undefined}
 */
function readBudgetOverride(trip, env) {
  const key = budgetEnvVarName(trip.id);
  const raw = env[key];

  // GitHub Actions inietta una secret inesistente come **stringa vuota**, non
  // come variabile assente: `env.X` esiste ma vale "". Trattare "" come "valore
  // non valido" faceva morire l'intero run con un messaggio fuorviante ("valore
  // non valido") per quella che è in realtà una secret mai creata — e senza mai
  // provare il fallback su config/trips.json. Vuoto = non fornito, punto.
  if (raw === undefined || String(raw).trim() === '') return undefined;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${key}: valore non valido ("${raw}"), deve essere un numero > 0 (solo cifre: "1500", non "1500 EUR").`,
    );
  }
  return parsed;
}

/** Missing or unreadable state is treated as "first run", never as a failure. */
async function loadState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.trips) {
      return { version: STATE_VERSION, lastUpdate: null, trips: {}, quota: emptyQuotaState() };
    }
    return { quota: emptyQuotaState(), ...parsed };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`⚠️  Stato precedente illeggibile (${error.message}). Tratto come prima esecuzione.`);
    }
    return { version: STATE_VERSION, lastUpdate: null, trips: {}, quota: emptyQuotaState() };
  }
}

async function saveState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Delta logic
// ---------------------------------------------------------------------------

/**
 * Decide whether this run deserves a notification.
 *
 * Notify when:
 *   a) there is no previous snapshot for this trip (first run);
 *   b) the winner (rank 1) changed;
 *   c) any destination's flight price dropped by >= `threshold`.
 *
 * `changed` is broader than `shouldNotify`: it is true whenever the stored
 * numbers differ at all, which is what decides if the snapshot gets rewritten.
 *
 * @param {object|null} previous  Previous trip snapshot.
 * @param {object} current        Fresh trip result from the engine.
 * @param {number} threshold      Minimum price drop, in the trip currency.
 */
export function computeDelta(previous, current, threshold) {
  const reasons = [];
  const drops = [];

  const priced = current.results.filter((result) => result.status === 'ok');
  const currentWinner = priced[0] ?? null;

  if (!previous || !Array.isArray(previous.results) || previous.results.length === 0) {
    reasons.push({ type: 'first_run', text: 'Prima esecuzione del monitoraggio' });
    return { shouldNotify: true, changed: true, reasons, drops, previousWinner: null, currentWinner };
  }

  const previousById = new Map(previous.results.map((result) => [result.id, result]));
  const previousWinner = previous.results.find((result) => result.rank === 1) ?? null;

  // (b) winner change
  if (currentWinner && previousWinner && currentWinner.id !== previousWinner.id) {
    reasons.push({
      type: 'winner_change',
      text: `Nuovo vincitore: ${currentWinner.name} (prima: ${previousWinner.name})`,
    });
  } else if (currentWinner && !previousWinner) {
    reasons.push({ type: 'winner_change', text: `Primo vincitore disponibile: ${currentWinner.name}` });
  }

  // (c) price drops
  let changed = false;

  for (const result of priced) {
    const before = previousById.get(result.id);
    if (!before || typeof before.price !== 'number') {
      changed = true;
      continue;
    }

    const diff = round2(before.price - result.price);
    if (diff !== 0) changed = true;

    if (diff >= threshold) {
      drops.push({
        id: result.id,
        name: result.name,
        hub: result.hub,
        from: before.price,
        to: result.price,
        drop: diff,
      });
    }
  }

  if (drops.length > 0) {
    reasons.push({
      type: 'price_drop',
      text: `${drops.length} calo/i di prezzo ≥ ${threshold} ${current.currency}`,
    });
  }

  // Ranking reshuffles and availability changes count as "changed" too, so the
  // snapshot stays truthful even when no notification is warranted.
  const previousOrder = previous.results.map((r) => `${r.id}:${r.rank ?? '-'}`).join('|');
  const currentOrder = current.results.map((r) => `${r.id}:${r.rank ?? '-'}`).join('|');
  if (previousOrder !== currentOrder) changed = true;

  if (previous.results.length !== current.results.length) changed = true;

  return {
    shouldNotify: reasons.length > 0,
    changed: changed || reasons.length > 0,
    reasons,
    drops,
    previousWinner,
    currentWinner,
  };
}

const round2 = (value) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * Render both the Telegram (HTML) and Slack (plain text) payloads.
 *
 * Forma: **tabelle monospaziate**, non elenchi puntati. Un elenco di sei righe
 * per destinazione, moltiplicato per cinque destinazioni, obbliga a rileggere
 * ogni riga per capire di cosa parla; incolonnare gli stessi numeri li rende
 * confrontabili con lo sguardo — che è l'unica cosa che si fa davvero con una
 * notifica sul telefono.
 *
 * Vincolo tecnico che detta il resto: Telegram non ha un markup di tabella. Le
 * tabelle sono blocchi `<pre>` allineati a spazi, e un `<pre>` **non va a
 * capo** — scorre in orizzontale. Ogni riga sta perciò dentro
 * `MAX_TABLE_WIDTH`, e `splitMessage` (notifier.js) sa richiudere e riaprire i
 * blocchi quando un messaggio lungo va spezzato.
 *
 * @param {object} trip     Engine trip result.
 * @param {object} delta    Output of computeDelta.
 * @returns {{ html: string, text: string }}
 */
export function renderMessage(trip, delta) {
  const cur = trip.currency;
  const htmlLines = [];
  const textLines = [];

  const push = (html, text) => {
    htmlLines.push(html);
    textLines.push(text ?? stripTags(html));
  };

  /** Una tabella: `<pre>` su Telegram, blocco di codice su Slack. */
  const pushTable = (rows) => {
    const table = renderTable(rows);
    if (!table) return;
    push(`<pre>${escapeHtml(table)}</pre>`, '```\n' + table + '\n```');
  };

  push(`✈️ <b>${escapeHtml(trip.tripName)}</b>`, `✈️ ${trip.tripName}`);
  push(
    `🗓 ${formatDay(trip.departureWindow.from)} → ${formatDay(trip.departureWindow.to)} · ${trip.tripDuration.min}-${trip.tripDuration.max} giorni`,
    `🗓 ${formatDay(trip.departureWindow.from)} → ${formatDay(trip.departureWindow.to)} | ${trip.tripDuration.min}-${trip.tripDuration.max} giorni`,
  );
  push(`🛫 Da: ${airportListLabel(trip.origins)}`, `🛫 Da: ${airportListLabel(trip.origins)}`);
  push('', '');

  // Dichiarato in cima e non a piè di pagina: chi legge deve sapere *prima*
  // dei numeri che sta guardando una classifica per prezzo, non per giorni.
  if (trip.budgetMissing) {
    push(
      '⚠️ <b>Budget non impostato</b> — classifica per solo prezzo del volo; giorni sostenibili e costo totale non calcolabili.',
      '⚠️ Budget non impostato — classifica per solo prezzo del volo; giorni sostenibili e costo totale non calcolabili.',
    );
    push('', '');
  }

  // Una riga sola, non un blocco con titolo: il motivo per cui il messaggio è
  // arrivato è contesto, non contenuto, e non deve competere con i numeri.
  for (const reason of delta.reasons) {
    push(`ℹ️ <i>${escapeHtml(reason.text)}</i>`, `ℹ️ ${reason.text}`);
  }
  push('', '');

  const priced = trip.results.filter((result) => result.status === 'ok');

  if (priced.length === 0) {
    push('Nessun volo trovato in questa esecuzione.', 'Nessun volo trovato in questa esecuzione.');
  }

  // --- Riepilogo: tutte le mete a confronto, una riga ciascuna --------------
  if (priced.length > 0) {
    const criterio = trip.budgetMissing ? 'per prezzo' : 'per giorni, poi costo';
    push(`<b>🏆 Classifica</b> <i>(${criterio})</i>`, `🏆 Classifica (${criterio})`);

    const header = trip.budgetMissing
      ? ['#', 'Destinazione', 'Volo', 'Da']
      : ['#', 'Destinazione', 'Volo', 'Giorni'];

    pushTable([
      header,
      ...priced.map((result) => [
        String(result.rank),
        truncate(result.name, 17),
        formatPrice(result.price, cur),
        trip.budgetMissing
          ? airportCity(result.origin)
          : `${result.maxDays}/${result.maxTripDays}`,
      ]),
    ]);
    push('', '');
  }

  // --- Dettaglio per destinazione ------------------------------------------
  for (const result of priced) {
    const medal = MEDALS[result.rank - 1] ?? `${result.rank}.`;
    // `feasible === null` = non valutabile (nessun budget), diverso da `false`
    // = valutato e insufficiente. Un avviso inventato sarebbe peggio di nessuno.
    const feasibility = result.feasible === false ? ' ⚠️ sotto la durata minima' : '';

    push(
      `${medal} <b>${escapeHtml(result.name)}</b> · ${escapeHtml(airportLabel(result.hub))}${feasibility}`,
      `${medal} ${result.name} · ${airportLabel(result.hub)}${feasibility}`,
    );

    pushTable(flightRows(result, trip, cur));

    // Confronto fra aeroporti di partenza: la domanda vera non è "qual è il
    // volo più economico" ma "quanto mi costa partire da casa mia".
    const groups = (result.originBreakdown ?? []).filter((group) => group.status === 'ok');
    if (groups.length > 1) {
      push('<i>Partenze a confronto</i>', 'Partenze a confronto');
      pushTable([
        ['Da', 'Volo', 'Diff.', 'Durata'],
        ...groups.map((group) => [
          truncate(group.label, 10),
          formatPrice(group.price, cur),
          group.isBest ? '—' : `+${group.extraVsBest}`,
          formatDuration(group.outbound?.durationMinutes ?? group.durationMinutes),
        ]),
      ]);
    }

    // Combinazioni open-jaw: andata e ritorno da aeroporti diversi. A
    // differenza del blocco sopra (volo A/R, ritorno senza orario per
    // risparmiare quota), qui ogni tratta è una ricerca one-way a sé, quindi
    // orari e scali sono sempre completi su entrambe le tratte.
    const combos = result.openJawCombos ?? [];
    if (combos.length > 0) {
      push('<i>🔀 Andata/ritorno da aeroporti diversi</i>', '🔀 Andata/ritorno da aeroporti diversi');
      for (const combo of combos) {
        const sameAirport = combo.originOut.id === combo.originBack.id;
        push(
          `<b>${escapeHtml(combo.originOut.label)} → ${escapeHtml(combo.originBack.label)}</b>` +
            (sameAirport ? ' <i>(A/R classico)</i>' : ' <i>(open-jaw)</i>') +
            ` · <b>${formatPrice(combo.price, cur)}</b>`,
          `${combo.originOut.label} → ${combo.originBack.label}` +
            (sameAirport ? ' (A/R classico)' : ' (open-jaw)') +
            ` · ${formatPrice(combo.price, cur)}`,
        );
        push(
          `   ✈️ ${escapeHtml(legSummary(combo.outbound))}`,
          `   ✈️ ${legSummary(combo.outbound)}`,
        );
        push(
          `   🔙 ${escapeHtml(legSummary(combo.returnFlight))}`,
          `   🔙 ${legSummary(combo.returnFlight)}`,
        );
      }
      push('', '');
    }

    const drop = delta.drops.find((item) => item.id === result.id);
    if (drop) {
      push(
        `📉 <b>-${formatPrice(drop.drop, cur)}</b> (era ${formatPrice(drop.from, cur)})`,
        `📉 -${formatPrice(drop.drop, cur)} (era ${formatPrice(drop.from, cur)})`,
      );
    }
    if (result.bookingUrl) {
      push(
        `🔗 <a href="${escapeHtml(result.bookingUrl)}">Apri su Google Flights</a>`,
        `🔗 ${result.bookingUrl}`,
      );
    }
    push('', '');
  }

  // Destinations without a usable price.
  const problems = trip.results.filter((result) => result.status !== 'ok');
  if (problems.length > 0) {
    push('<b>⚠️ Senza prezzo in questa esecuzione</b>', '⚠️ Senza prezzo in questa esecuzione');
    for (const result of problems) {
      const label = {
        no_flights: 'nessun volo trovato',
        quota_exceeded: 'quota API esaurita',
        error: 'errore API',
      }[result.status] ?? result.status;

      push(
        `• ${escapeHtml(result.name)} (${escapeHtml(airportLabel(result.hub))}): ${label}`,
        `• ${result.name} (${airportLabel(result.hub)}): ${label}`,
      );
    }
    push('', '');
  }

  push(
    `<i>Provider: ${trip.provider} · ${trip.apiCallsUsed}/${trip.apiCallsBudget} ricerche · ${formatTimestamp(trip.generatedAt)}</i>`,
    `Provider: ${trip.provider} | ${trip.apiCallsUsed}/${trip.apiCallsBudget} ricerche | ${formatTimestamp(trip.generatedAt)}`,
  );

  return { html: htmlLines.join('\n'), text: textLines.join('\n') };
}

/**
 * Le righe della tabella di dettaglio di una destinazione.
 *
 * Ogni riga è opzionale: un provider che non espone orari o scali produce una
 * tabella più corta, non una tabella piena di "n/d". Mostrare il nulla in modo
 * ordinato è peggio che non mostrarlo.
 */
function flightRows(result, trip, cur) {
  const rows = [['Volo A/R', formatPrice(result.price, cur)]];
  const outbound = result.outbound ?? null;

  if (outbound?.departureTime) {
    rows.push([
      'Partenza',
      `${airportLabel(outbound.departureAirport ?? result.origin)} ${formatDateTime(outbound.departureTime)}`,
    ]);
  } else {
    rows.push(['Partenza', `${airportLabel(result.origin)} ${formatDay(result.outboundDate)}`]);
  }

  if (outbound?.arrivalTime) {
    rows.push([
      'Arrivo',
      `${airportLabel(outbound.arrivalAirport ?? result.hub)} ${formatDateTime(outbound.arrivalTime)}`,
    ]);
  }

  const duration = outbound?.durationMinutes ?? result.durationMinutes;
  const stops = outbound?.stops ?? result.stops;
  if (Number.isFinite(duration) || Number.isFinite(stops)) {
    const pieces = [];
    if (Number.isFinite(duration)) pieces.push(formatDuration(duration));
    if (Number.isFinite(stops)) pieces.push(stops === 0 ? 'diretto' : `${stops} scalo${stops > 1 ? 'i' : ''}`);
    rows.push(['Durata', pieces.join(' · ')]);
  }

  for (const layover of outbound?.layovers ?? []) {
    rows.push([
      'Scalo',
      [
        airportLabel(layover.airport),
        formatDuration(layover.durationMinutes),
        layover.overnight ? 'notturno' : null,
      ]
        .filter(Boolean)
        .join(' · '),
    ]);
  }

  const airlines = outbound?.airlines ?? result.airlines ?? [];
  if (airlines.length > 0) rows.push(['Compagnia', truncate(airlines.join(', '), 30)]);

  // Del ritorno si conosce solo la data: i suoi orari costerebbero una seconda
  // chiamata API per destinazione (vedi il commento in serpapi.js).
  rows.push(['Ritorno', `${formatDay(result.returnDate)} · ${result.durationDays} giorni`]);

  if (Number.isFinite(result.maxDays)) {
    rows.push([
      'Giorni',
      `${result.maxDays}/${result.maxTripDays}${result.budgetCoversFullTrip ? ' pieni' : ' (budget)'}`,
    ]);
    rows.push(['Totale', `${formatPrice(result.totalCostStandard, cur)} · ${result.standardDays} gg`]);
  }

  rows.push([
    'A terra',
    `${formatPrice(result.groundCostPerDay, cur)}/gg` +
      (result.fixedExtra > 0 ? ` + ${formatPrice(result.fixedExtra, cur)}` : ''),
  ]);

  return rows;
}

/**
 * Una tratta one-way in una riga: "TRN 14/09 13:20 → CMB 15/09 05:15 · 15h55m
 * · scalo a DXB 5h16m (notturno)". A differenza del volo A/R sopra, qui
 * orario e scalo sono sempre noti su entrambe le tratte — è una ricerca
 * one-way a sé, non la metà di un A/R di cui si conosce solo la data.
 * @param {import('./api/flightProvider.js').ItineraryDetails|null} leg
 */
function legSummary(leg) {
  if (!leg?.departureTime) return 'n/d';

  const from = `${airportLabel(leg.departureAirport)} ${formatDateTime(leg.departureTime)}`;
  const to = `${airportLabel(leg.arrivalAirport)} ${formatDateTime(leg.arrivalTime)}`;

  const layovers = leg.layovers ?? [];
  const stopsLabel =
    leg.stops === 0
      ? 'diretto'
      : layovers.length > 0
        ? layovers
            .map(
              (layover) =>
                `scalo a ${airportLabel(layover.airport)} ${formatDuration(layover.durationMinutes)}` +
                (layover.overnight ? ' (notturno)' : ''),
            )
            .join(', ')
        : Number.isFinite(leg.stops)
          ? `${leg.stops} scalo${leg.stops > 1 ? 'i' : ''}`
          : null;

  return `${from} → ${to} · ${formatDuration(leg.durationMinutes)}` + (stopsLabel ? ` · ${stopsLabel}` : '');
}

function stripTags(value) {
  return value
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function formatTimestamp(iso) {
  return new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Trim an engine result down to what the snapshot needs to diff next time.
 *
 * Deliberately excludes `budgetTotal` and `maxDaysBudget`: this file is
 * committed to git. `budgetTotal` is the private figure supplied via the
 * `BUDGET_<TRIP_ID>` env var and must never end up in version control.
 * `maxDaysBudget` is excluded too because it is the *uncapped* days figure —
 * combined with the public `groundCostPerDay` and the flight `price` shown
 * right next to it, it would let anyone reverse the exact budget out of the
 * committed file. `maxDays` (capped at the trip's max length) carries none of
 * that risk and is kept.
 */
function toSnapshot(tripResult) {
  return {
    tripName: tripResult.tripName,
    provider: tripResult.provider,
    currency: tripResult.currency,
    updatedAt: tripResult.generatedAt,
    winner: tripResult.results.find((result) => result.rank === 1)?.id ?? null,
    results: tripResult.results.map((result) => ({
      id: result.id,
      name: result.name,
      hub: result.hub,
      rank: result.rank,
      status: result.status,
      price: result.price,
      origin: result.origin ?? null,
      outboundDate: result.outboundDate ?? null,
      returnDate: result.returnDate ?? null,
      maxDays: result.maxDays,
      totalCostStandard: result.totalCostStandard,
      // Solo prezzo e rotta: nessun dato derivato dal budget privato finisce
      // qui (vedi il commento sopra su maxDaysBudget). Serviranno anche come
      // storico per confronto nel tempo, aeroporto per aeroporto.
      originBreakdown: (result.originBreakdown ?? []).map((group) => ({
        id: group.id,
        status: group.status,
        price: group.price ?? null,
        origin: group.origin ?? null,
        outboundDate: group.outboundDate ?? null,
        returnDate: group.returnDate ?? null,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// GitHub Actions job summary (no-op outside CI)
// ---------------------------------------------------------------------------

async function writeJobSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    await writeFile(summaryPath, `${lines.join('\n')}\n`, { flag: 'a' });
  } catch (error) {
    console.warn(`⚠️  Impossibile scrivere il job summary: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  console.log('════════════════════════════════════════════');
  console.log('  ✈️  Looking for Flights — monitoraggio');
  console.log('════════════════════════════════════════════');

  const config = await loadConfig(args.configPath);
  const state = await loadState(args.statePath);

  const providerName =
    args.provider || process.env.FLIGHT_PROVIDER || config.defaults.provider || 'serpapi';

  const provider = await createFlightProvider(providerName);
  console.log(`🔌 Provider: ${provider.name}${args.dryRun ? ' · DRY RUN' : ''}`);

  const channels = config.defaults.notify?.channels ?? ['telegram', 'slack'];
  const configured = availableChannels();
  if (configured.length === 0 && !args.dryRun) {
    console.warn('⚠️  Nessun canale di notifica configurato: il run calcolerà i prezzi senza notificare.');
  }

  const trips = config.trips
    .filter((trip) => trip.enabled !== false)
    .filter((trip) => !args.tripId || trip.id === args.tripId);

  if (trips.length === 0) {
    console.warn('⚠️  Nessun viaggio abilitato da elaborare.');
    return 0;
  }

  const nextState = {
    version: STATE_VERSION,
    lastUpdate: state.lastUpdate,
    trips: { ...state.trips },
    quota: state.quota ?? emptyQuotaState(),
  };

  // Quanta quota API resta prima ancora di interrogare il provider. Il tetto
  // per-run non bastava: limitava la singola esecuzione, non quante volte la
  // si lancia.
  const quotaConfig = config.defaults.apiQuota ?? {};
  const mode = process.env.RUN_MODE === 'ondemand' || args.forceNotify ? 'ondemand' : 'scheduled';
  const usedSoFar = usageInWindow(nextState.quota, today(), quotaConfig.windowDays);
  const allowance = remainingAllowance(quotaConfig, usedSoFar, mode);

  if (Number.isFinite(allowance.cap)) {
    console.log(
      `📊 Quota API: ${allowance.used}/${allowance.cap} usate (${mode}) · ` +
        `${allowance.allowed} disponibili in questo run`,
    );
  }
  const summaryLines = ['## ✈️ Looking for Flights', ''];
  let stateChanged = false;
  let hadFailure = false;
  /** Viaggi saltati per quota: vanno comunicati, non lasciati in silenzio. */
  const quotaBlocked = [];

  for (const trip of trips) {
    console.log(`\n──── ${trip.name} (${trip.id}) ────`);

    if (Number.isFinite(args.budgetOverride) && args.budgetOverride > 0) {
      trip.budgetTotal = args.budgetOverride;
    }

    // Senza budget si perde il calcolo dei giorni sostenibili, non la ricerca:
    // i prezzi dei voli restano l'80% del valore di un /cerca. Fermare tutto
    // qui significava rispondere "niente" a chi aspettava, quando la risposta
    // utile era a una chiamata API di distanza. La mancanza viene dichiarata
    // in cima alla notifica, così nessuno scambia una classifica per prezzo
    // per una classifica per giorni.
    if (!Number.isFinite(Number(trip.budgetTotal)) || Number(trip.budgetTotal) <= 0) {
      const key = budgetEnvVarName(trip.id);
      console.warn(
        `⚠️  [${trip.id}] Budget non impostato: imposta ${key} (GitHub Secret o variabile in CI, ` +
          `riga in .env in locale) oppure "budgetTotal" in config/trips.json. ` +
          `Procedo con la classifica per solo prezzo del volo.`,
      );
      trip.budgetTotal = null;
    }

    // La quota residua vince sul tetto configurato: `maxApiCallsPerRun` dice
    // quanto *vorremmo* spendere, l'allowance quanto *possiamo*. A zero il run
    // non parte nemmeno — una ricerca che sappiamo essere rifiutata dall'API è
    // solo un modo più lento di fallire.
    if (allowance.exhausted) {
      const ripresa = nextReleaseDate(nextState.quota, quotaConfig.windowDays);
      const messaggio =
        `Quota API esaurita: ${allowance.used}/${allowance.cap} ricerche negli ultimi ` +
        `${quotaConfig.windowDays ?? 30} giorni` +
        (mode === 'scheduled' && quotaConfig.reserveForOnDemand
          ? ` (riserva di ${quotaConfig.reserveForOnDemand} tenuta per /cerca)`
          : '') +
        (ripresa ? `. Torna disponibile dal ${ripresa}.` : '.');

      console.warn(`⏸️  [${trip.id}] ${messaggio}`);
      summaryLines.push(`### ⏸️ ${trip.name}`, '', messaggio, '');
      quotaBlocked.push(messaggio);
      continue;
    }

    if (Number.isFinite(allowance.allowed)) {
      trip.sampling = {
        ...trip.sampling,
        maxApiCallsPerRun: Math.min(
          Number(trip.sampling?.maxApiCallsPerRun) || allowance.allowed,
          allowance.allowed,
        ),
      };
    }

    let tripResult;
    try {
      tripResult = await runTrip(trip, provider);
    } catch (error) {
      hadFailure = true;
      console.error(`❌ [${trip.id}] Esecuzione fallita: ${error.message}`);
      summaryLines.push(`### ❌ ${trip.name}`, '', `Esecuzione fallita: \`${error.message}\``, '');
      continue;
    }

    // Registrato sempre, anche se poi la notifica non parte: le ricerche sono
    // state consumate comunque, e uno stato che le dimentica riaprirebbe la
    // porta allo sforamento che questo contatore esiste per impedire.
    if (tripResult.apiCallsUsed > 0) {
      nextState.quota = recordUsage(
        nextState.quota,
        today(),
        tripResult.apiCallsUsed,
        quotaConfig.windowDays,
      );
      allowance.allowed = Math.max(0, allowance.allowed - tripResult.apiCallsUsed);
      allowance.used += tripResult.apiCallsUsed;
      allowance.exhausted = allowance.allowed <= 0;
      stateChanged = true;
    }

    const threshold = Number(trip.notify?.priceDropThreshold ?? 15);
    const previous = state.trips?.[trip.id] ?? null;
    const delta = computeDelta(previous, tripResult, threshold);

    if (args.forceNotify && delta.reasons.length === 0) {
      delta.reasons.push({ type: 'forced', text: 'Notifica forzata (--force-notify)' });
      delta.shouldNotify = true;
    }

    const priced = tripResult.results.filter((result) => result.status === 'ok');
    const winner = priced[0];

    console.log(
      winner
        ? `🏆 Vincitore: ${winner.name} — ` +
          (Number.isFinite(winner.maxDays) ? `${winner.maxDays}/${winner.maxTripDays} giorni, ` : '') +
          `volo ${winner.price} ${tripResult.currency}`
        : '🏆 Nessun vincitore: nessun volo con prezzo valido.',
    );
    console.log(
      delta.shouldNotify
        ? `🔔 Notifica: SÌ (${delta.reasons.map((r) => r.type).join(', ')})`
        : '🔕 Notifica: no (nessuna variazione rilevante)',
    );

    if (tripResult.quotaExhausted) hadFailure = true;

    // --- notify -----------------------------------------------------------
    if (delta.shouldNotify && !args.dryRun) {
      const message = renderMessage(tripResult, delta);
      const { delivered, results } = await sendNotification(message, { channels });

      for (const result of results) {
        const icon = { sent: '✅', skipped: '➖', failed: '❌' }[result.status];
        console.log(`   ${icon} ${result.channel}: ${result.status}${result.reason ? ` — ${result.reason}` : ''}`);
      }
      if (!delivered && configured.length > 0) hadFailure = true;
    } else if (delta.shouldNotify && args.dryRun) {
      console.log('\n--- ANTEPRIMA NOTIFICA (dry run) ---');
      console.log(renderMessage(tripResult, delta).text);
      console.log('--- FINE ANTEPRIMA ---\n');
    }

    // --- persist ----------------------------------------------------------
    if (delta.changed || delta.shouldNotify) {
      nextState.trips[trip.id] = toSnapshot(tripResult);
      stateChanged = true;
    }

    // --- CI summary -------------------------------------------------------
    summaryLines.push(`### ${trip.name}`, '');
    if (priced.length > 0) {
      summaryLines.push(
        '| # | Destinazione | Volo A/R | Da | Date | Giorni | Totale std |',
        '|---|---|---|---|---|---|---|',
        ...priced.map(
          (r) =>
            `| ${r.rank} | ${r.name} (${r.hub}) | ${r.price} ${tripResult.currency} | ${r.origin} | ` +
            `${r.outboundDate} → ${r.returnDate} | ` +
            (Number.isFinite(r.maxDays) ? `**${r.maxDays}**/${r.maxTripDays}` : '—') +
            ' | ' +
            (Number.isFinite(r.totalCostStandard) ? `${r.totalCostStandard} ${tripResult.currency}` : '—') +
            ' |',
        ),
      );
    } else {
      summaryLines.push('Nessun volo trovato.');
    }
    summaryLines.push(
      '',
      `Notifica inviata: **${delta.shouldNotify && !args.dryRun ? 'sì' : 'no'}** · Ricerche API: ${tripResult.apiCallsUsed}/${tripResult.apiCallsBudget}`,
      '',
    );
  }

  // --- quota esaurita: dirlo, non sparire ---------------------------------
  // Un run che si ferma in silenzio è indistinguibile da "nessuna variazione
  // di prezzo": è lo stesso equivoco che rendeva invisibili i fallimenti.
  if (quotaBlocked.length > 0 && !args.dryRun) {
    const testo = `⏸️ <b>Ricerca sospesa</b>\n${quotaBlocked.map((line) => escapeHtml(line)).join('\n')}`;
    await sendNotification({ html: testo, text: stripTags(testo) }, { channels });
  }

  // --- avviso di avvicinamento alla quota ----------------------------------
  // Confronto prima/dopo il run per notificare solo al momento in cui la
  // soglia viene superata, non a ogni run successivo finché resta sopra.
  const warnAt = Number(quotaConfig.warnAt);
  if (Number.isFinite(warnAt) && warnAt > 0 && !args.dryRun) {
    const usedNow = usageInWindow(nextState.quota, today(), quotaConfig.windowDays);
    if (usedSoFar < warnAt && usedNow >= warnAt) {
      const testo =
        `⚠️ <b>Quota API in avvicinamento al tetto</b>\n` +
        `${usedNow}/${quotaConfig.monthlySearches ?? '?'} ricerche usate negli ultimi ` +
        `${quotaConfig.windowDays ?? 30} giorni (soglia di avviso: ${warnAt}).`;
      await sendNotification({ html: testo, text: stripTags(testo) }, { channels });
    }
  }

  // --- write state --------------------------------------------------------
  if (stateChanged && !args.dryRun) {
    nextState.lastUpdate = new Date().toISOString();
    await saveState(args.statePath, nextState);
    console.log(`\n💾 Stato aggiornato: ${path.relative(ROOT, args.statePath)}`);
  } else if (stateChanged) {
    console.log('\n💾 Stato NON scritto (dry run).');
  } else {
    console.log('\n💾 Nessuna variazione: stato invariato.');
  }

  await writeJobSummary(summaryLines);

  // A failed API/notification should surface in CI without blocking the commit
  // of the data we did manage to collect.
  return hadFailure ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof ProviderConfigError) {
      console.error(`\n❌ Configurazione provider: ${error.message}`);
    } else {
      console.error(`\n❌ Errore fatale: ${error.message}`);
      if (process.env.DEBUG) console.error(error.stack);
    }
    process.exitCode = 1;
  });
