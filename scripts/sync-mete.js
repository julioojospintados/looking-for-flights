#!/usr/bin/env node
/**
 * Sincronizza `config/mete.txt` dentro `config/trips.json`.
 *
 * `mete.txt` è il file "umano": una riga per meta, nessuna parentesi graffa.
 * Questo script lo traduce nella sezione `candidates` del viaggio scelto,
 * lasciando intatto tutto il resto della configurazione.
 *
 * Regole di merge:
 *  - L'identità di una meta è il codice HUB. Se l'HUB esiste già, `id` e
 *    `notes` vengono conservati: lo storico in data/last_prices.json resta
 *    agganciato anche se rinomini la meta o cambi i costi.
 *  - Se l'HUB è nuovo, l'id viene generato dal nome (slug).
 *  - Le mete non più presenti nel file vengono rimosse.
 *
 * Uso:
 *   node scripts/sync-mete.js               # sincronizza il primo viaggio
 *   node scripts/sync-mete.js --trip=<id>   # sceglie il viaggio
 *   node scripts/sync-mete.js --check       # non scrive, esce 1 se disallineato
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METE_PATH = path.join(ROOT, 'config', 'mete.txt');
const TRIPS_PATH = path.join(ROOT, 'config', 'trips.json');

const IATA = /^[A-Z]{3}$/;

// ---------------------------------------------------------------------------
// Parsing di mete.txt
// ---------------------------------------------------------------------------

/**
 * @param {string} content
 * @returns {{ mete: Array<{name:string,hub:string,groundCostPerDay:number,fixedExtra:number}>, errors: string[] }}
 */
export function parseMete(content) {
  const mete = [];
  const errors = [];
  const hubVisti = new Map();

  content.split(/\r?\n/).forEach((rawLine, index) => {
    const numeroRiga = index + 1;
    const line = rawLine.trim();

    if (line === '' || line.startsWith('#')) return;

    const parts = line.split('|').map((part) => part.trim());

    if (parts.length !== 4) {
      errors.push(
        `riga ${numeroRiga}: attesi 4 campi separati da "|", trovati ${parts.length} → "${line}"`,
      );
      return;
    }

    const [name, hubRaw, costRaw, extraRaw] = parts;
    const hub = hubRaw.toUpperCase();
    const groundCostPerDay = Number(costRaw.replace(',', '.'));
    const fixedExtra = Number(extraRaw.replace(',', '.'));

    if (!name) errors.push(`riga ${numeroRiga}: nome della meta vuoto`);
    if (!IATA.test(hub)) errors.push(`riga ${numeroRiga}: HUB "${hubRaw}" non è un codice IATA di 3 lettere`);
    if (!Number.isFinite(groundCostPerDay) || groundCostPerDay <= 0) {
      errors.push(`riga ${numeroRiga}: spesa/giorno "${costRaw}" deve essere un numero > 0`);
    }
    if (!Number.isFinite(fixedExtra) || fixedExtra < 0) {
      errors.push(`riga ${numeroRiga}: extra fissi "${extraRaw}" deve essere un numero >= 0`);
    }

    if (hubVisti.has(hub)) {
      errors.push(`riga ${numeroRiga}: HUB "${hub}" già usato alla riga ${hubVisti.get(hub)}`);
      return;
    }
    hubVisti.set(hub, numeroRiga);

    mete.push({ name, hub, groundCostPerDay, fixedExtra });
  });

  if (mete.length === 0 && errors.length === 0) {
    errors.push('nessuna meta attiva: tutte le righe sono vuote o commentate');
  }

  return { mete, errors };
}

/** "Thailandia (Isole del Golfo)" → "thailandia-isole-del-golfo" */
export function slugify(name) {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // rimuove gli accenti
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Merge nella configurazione
// ---------------------------------------------------------------------------

/**
 * @param {Array} mete           Mete lette da mete.txt
 * @param {Array} esistenti      Candidates attuali in trips.json
 * @returns {{ candidates: Array, changes: string[] }}
 */
export function mergeCandidates(mete, esistenti) {
  const perHub = new Map(esistenti.map((candidate) => [candidate.hub, candidate]));
  const changes = [];

  const candidates = mete.map((meta) => {
    const precedente = perHub.get(meta.hub);

    if (!precedente) {
      changes.push(`+ aggiunta   ${meta.name} (${meta.hub})`);
      return {
        id: slugify(meta.name),
        name: meta.name,
        hub: meta.hub,
        groundCostPerDay: meta.groundCostPerDay,
        fixedExtra: meta.fixedExtra,
        notes: null,
      };
    }

    const diffs = [];
    if (precedente.name !== meta.name) diffs.push(`nome "${precedente.name}" → "${meta.name}"`);
    if (Number(precedente.groundCostPerDay) !== meta.groundCostPerDay) {
      diffs.push(`€/gg ${precedente.groundCostPerDay} → ${meta.groundCostPerDay}`);
    }
    if (Number(precedente.fixedExtra ?? 0) !== meta.fixedExtra) {
      diffs.push(`extra ${precedente.fixedExtra ?? 0} → ${meta.fixedExtra}`);
    }
    if (diffs.length > 0) changes.push(`~ modificata ${meta.name} (${meta.hub}): ${diffs.join(', ')}`);

    // id e notes sopravvivono: lo storico dei prezzi resta agganciato.
    return {
      ...precedente,
      name: meta.name,
      hub: meta.hub,
      groundCostPerDay: meta.groundCostPerDay,
      fixedExtra: meta.fixedExtra,
    };
  });

  const hubAttivi = new Set(mete.map((meta) => meta.hub));
  for (const precedente of esistenti) {
    if (!hubAttivi.has(precedente.hub)) {
      changes.push(`- rimossa    ${precedente.name} (${precedente.hub})`);
    }
  }

  return { candidates, changes };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const soloCheck = args.includes('--check');
  const tripArg = args.find((arg) => arg.startsWith('--trip='))?.slice('--trip='.length) ?? null;

  const { mete, errors } = parseMete(await readFile(METE_PATH, 'utf8'));

  if (errors.length > 0) {
    console.error(`❌ Errori in config/mete.txt:\n   - ${errors.join('\n   - ')}`);
    return 1;
  }

  const config = JSON.parse(await readFile(TRIPS_PATH, 'utf8'));
  const trip = tripArg
    ? config.trips.find((candidate) => candidate.id === tripArg)
    : config.trips[0];

  if (!trip) {
    console.error(
      `❌ Viaggio "${tripArg}" non trovato. Disponibili: ${config.trips.map((t) => t.id).join(', ')}`,
    );
    return 1;
  }

  const { candidates, changes } = mergeCandidates(mete, trip.candidates ?? []);

  console.log(`📄 config/mete.txt → viaggio "${trip.id}"`);
  console.log(`   ${mete.length} mete attive: ${mete.map((meta) => meta.hub).join(', ')}`);

  if (changes.length === 0) {
    console.log('✅ Già allineato: nessuna modifica da applicare.');
    return 0;
  }

  console.log('\nModifiche:');
  for (const change of changes) console.log(`   ${change}`);

  if (soloCheck) {
    console.error('\n❌ config/trips.json non è allineato a config/mete.txt. Lancia: npm run mete');
    return 1;
  }

  trip.candidates = candidates;
  await writeFile(TRIPS_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  console.log(`\n💾 config/trips.json aggiornato.`);

  // Il costo in chiamate API dipende dal numero di mete: se cambia, il tetto
  // configurato può diventare troppo stretto (o inutilmente largo).
  const { departureStrideDays = 14, durationsToTest = [], maxApiCallsPerRun } = trip.sampling ?? {};
  const giorniFinestra =
    (new Date(trip.departureWindow.to) - new Date(trip.departureWindow.from)) / 86_400_000;
  const dateCampionate = Math.floor(giorniFinestra / departureStrideDays) + 2;
  const ricerche = candidates.length * dateCampionate * Math.max(1, durationsToTest.length);

  console.log(
    `   📊 Ricerche stimate per run: ~${ricerche} ` +
      `(${candidates.length} mete × ~${dateCampionate} date × ${durationsToTest.length || 1} durate)`,
  );
  if (maxApiCallsPerRun && ricerche > maxApiCallsPerRun) {
    console.log(
      `   ⚠️  Superano il tetto "maxApiCallsPerRun" (${maxApiCallsPerRun}): le ultime mete ` +
        `verrebbero saltate. Alza il tetto o allarga "departureStrideDays".`,
    );
  }

  console.log('\n   Verifica con:  npm run mock');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
