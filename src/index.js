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
import { availableChannels, escapeHtml, sendNotification } from './utils/notifier.js';

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
  };

  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force-notify') args.forceNotify = true;
    else if (arg.startsWith('--provider=')) args.provider = arg.slice('--provider='.length);
    else if (arg.startsWith('--config=')) args.configPath = path.resolve(arg.slice('--config='.length));
    else if (arg.startsWith('--state=')) args.statePath = path.resolve(arg.slice('--state='.length));
    else if (arg.startsWith('--trip=')) args.tripId = arg.slice('--trip='.length);
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

async function loadConfig(configPath) {
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
  }));

  config.defaults = defaults;
  return config;
}

/** Missing or unreadable state is treated as "first run", never as a failure. */
async function loadState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.trips) {
      return { version: STATE_VERSION, lastUpdate: null, trips: {} };
    }
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`⚠️  Stato precedente illeggibile (${error.message}). Tratto come prima esecuzione.`);
    }
    return { version: STATE_VERSION, lastUpdate: null, trips: {} };
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

  push(
    `✈️ <b>${escapeHtml(trip.tripName)}</b>`,
    `✈️ ${trip.tripName}`,
  );
  push(
    `💰 Budget: <b>${trip.budgetTotal} ${cur}</b> · 🗓 ${trip.departureWindow.from} → ${trip.departureWindow.to} · ${trip.tripDuration.min}-${trip.tripDuration.max} giorni`,
    `💰 Budget: ${trip.budgetTotal} ${cur} | 🗓 ${trip.departureWindow.from} → ${trip.departureWindow.to} | ${trip.tripDuration.min}-${trip.tripDuration.max} giorni`,
  );
  push(
    `🛫 Partenze da: ${trip.origins.join(', ')}`,
    `🛫 Partenze da: ${trip.origins.join(', ')}`,
  );
  push('', '');

  // Why you are receiving this message.
  push('<b>Perché ricevi questa notifica</b>', 'Perché ricevi questa notifica');
  for (const reason of delta.reasons) {
    push(`• ${escapeHtml(reason.text)}`, `• ${reason.text}`);
  }
  push('', '');

  // Ranking. Once several destinations can all afford the full trip they tie on
  // days, so the tie-break (total cost) is named in the header to avoid an
  // apparently arbitrary order.
  push(
    `<b>🏆 Classifica</b> — giorni sostenibili, poi costo totale`,
    `🏆 Classifica — giorni sostenibili, poi costo totale`,
  );

  const priced = trip.results.filter((result) => result.status === 'ok');

  if (priced.length === 0) {
    push('Nessun volo trovato in questa esecuzione.', 'Nessun volo trovato in questa esecuzione.');
  }

  for (const result of priced) {
    const medal = MEDALS[result.rank - 1] ?? `${result.rank}.`;
    const feasibility = result.feasible ? '' : ' ⚠️ sotto la durata minima';

    push(
      `${medal} <b>${escapeHtml(result.name)}</b> (${result.hub})${feasibility}`,
      `${medal} ${result.name} (${result.hub})${feasibility}`,
    );
    push(
      `   🛬 Volo A/R: <b>${result.price} ${cur}</b> da ${result.origin} · ${result.outboundDate} → ${result.returnDate}`,
      `   🛬 Volo A/R: ${result.price} ${cur} da ${result.origin} | ${result.outboundDate} → ${result.returnDate}`,
    );
    // With the trip length capped, "21/21" is the common case; what separates
    // destinations is the leftover budget, so it goes on the same line.
    const giorni = result.budgetCoversFullTrip
      ? `${result.maxDays}/${result.maxTripDays} gg pieni`
      : `${result.maxDays}/${result.maxTripDays} gg (budget insufficiente per ${result.maxTripDays})`;

    push(
      `   📅 <b>${giorni}</b> · 💸 ${result.groundCostPerDay} ${cur}/gg` +
        (result.fixedExtra > 0 ? ` + ${result.fixedExtra} ${cur} extra` : ''),
      `   📅 ${giorni} | 💸 ${result.groundCostPerDay} ${cur}/gg` +
        (result.fixedExtra > 0 ? ` + ${result.fixedExtra} ${cur} extra` : ''),
    );
    push(
      `   🧮 Totale ${result.standardDays} gg: ${result.totalCostStandard} ${cur} · avanzano <b>${result.marginStandard} ${cur}</b>`,
      `   🧮 Totale ${result.standardDays} gg: ${result.totalCostStandard} ${cur} | avanzano ${result.marginStandard} ${cur}`,
    );

    const drop = delta.drops.find((item) => item.id === result.id);
    if (drop) {
      push(
        `   📉 <b>-${drop.drop} ${cur}</b> (era ${drop.from} ${cur})`,
        `   📉 -${drop.drop} ${cur} (era ${drop.from} ${cur})`,
      );
    }
    if (result.bookingUrl) {
      push(`   🔗 <a href="${escapeHtml(result.bookingUrl)}">Apri su Google Flights</a>`, `   🔗 ${result.bookingUrl}`);
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
        `• ${escapeHtml(result.name)} (${result.hub}): ${label}`,
        `• ${result.name} (${result.hub}): ${label}`,
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

/** Trim an engine result down to what the snapshot needs to diff next time. */
function toSnapshot(tripResult) {
  return {
    tripName: tripResult.tripName,
    provider: tripResult.provider,
    currency: tripResult.currency,
    budgetTotal: tripResult.budgetTotal,
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
      maxDaysBudget: result.maxDaysBudget ?? null,
      totalCostStandard: result.totalCostStandard,
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

  const nextState = { version: STATE_VERSION, lastUpdate: state.lastUpdate, trips: { ...state.trips } };
  const summaryLines = ['## ✈️ Looking for Flights', ''];
  let stateChanged = false;
  let hadFailure = false;

  for (const trip of trips) {
    console.log(`\n──── ${trip.name} (${trip.id}) ────`);

    let tripResult;
    try {
      tripResult = await runTrip(trip, provider);
    } catch (error) {
      hadFailure = true;
      console.error(`❌ [${trip.id}] Esecuzione fallita: ${error.message}`);
      summaryLines.push(`### ❌ ${trip.name}`, '', `Esecuzione fallita: \`${error.message}\``, '');
      continue;
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
        ? `🏆 Vincitore: ${winner.name} — ${winner.maxDays}/${winner.maxTripDays} giorni, ` +
          `volo ${winner.price} ${tripResult.currency}, avanzano ${winner.marginStandard} ${tripResult.currency}`
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
        '| # | Destinazione | Volo A/R | Da | Date | Giorni | Totale std | Avanzano |',
        '|---|---|---|---|---|---|---|---|',
        ...priced.map(
          (r) =>
            `| ${r.rank} | ${r.name} (${r.hub}) | ${r.price} ${tripResult.currency} | ${r.origin} | ` +
            `${r.outboundDate} → ${r.returnDate} | **${r.maxDays}**/${r.maxTripDays} | ` +
            `${r.totalCostStandard} ${tripResult.currency} | ${r.marginStandard} ${tripResult.currency} |`,
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
