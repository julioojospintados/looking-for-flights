/**
 * Formattazione condivisa fra notifica Telegram, testo Slack e log.
 *
 * Le tabelle sono allineate a spazi dentro un blocco monospaziato: è l'unica
 * forma di tabella che Telegram sappia rendere (non esiste markup di tabella
 * nel suo HTML). Da qui il vincolo che detta tutte le larghezze qui sotto —
 * un blocco `<pre>` su Telegram **non va a capo**, scorre in orizzontale:
 * una riga troppo lunga non si rompe, si nasconde.
 */

/** Larghezza oltre la quale, su un telefono, la riga esce dallo schermo. */
export const MAX_TABLE_WIDTH = 46;

/**
 * Minuti → "11h 30m". Sotto l'ora resta solo "45m": "0h 45m" è rumore.
 * @param {number|null|undefined} minutes
 */
export function formatDuration(minutes) {
  // `Number(null)` vale 0, non NaN: senza questo controllo un dato mancante
  // diventerebbe un rassicurante "0m" invece di dichiararsi assente.
  if (minutes === null || minutes === undefined || minutes === '') return 'n/d';

  const total = Number(minutes);
  if (!Number.isFinite(total) || total < 0) return 'n/d';

  const hours = Math.floor(total / 60);
  const rest = Math.round(total % 60);
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
}

/**
 * "2026-09-15 10:35" → "15/09 10:35"; "2026-09-15" → "15/09".
 *
 * Gli orari dei provider sono **locali all'aeroporto** e senza fuso: vanno
 * riformattati come stringhe, mai passati da `new Date()`, che li
 * interpreterebbe nel fuso del runner (UTC in CI) spostando gli orari di ore.
 *
 * @param {string|null|undefined} raw
 */
export function formatDateTime(raw) {
  const value = String(raw ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(value);
  if (!match) return value || 'n/d';

  const [, , month, day, hour, minute] = match;
  const date = `${day}/${month}`;
  return hour !== undefined ? `${date} ${hour}:${minute}` : date;
}

/** Solo la data, anche se la stringa contiene un orario. @param {string} raw */
export function formatDay(raw) {
  return formatDateTime(raw).slice(0, 5);
}

/** Prezzo compatto: "426 €". Niente decimali quando sono .00. */
export function formatPrice(value, currency = 'EUR') {
  // Stesso motivo di `formatDuration`: un prezzo assente non è un prezzo zero.
  if (value === null || value === undefined || value === '') return 'n/d';

  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/d';
  const symbol = { EUR: '€', USD: '$', GBP: '£' }[currency] ?? currency;
  const rounded = Math.round(number * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)} ${symbol}`;
}

/**
 * Righe di celle → tabella allineata a spazi.
 *
 * L'ultima colonna non viene mai riempita di spazi in coda: allargherebbe la
 * riga senza aggiungere informazione, e su Telegram la larghezza è la risorsa
 * scarsa.
 *
 * @param {Array<Array<string>>} rows
 * @param {{ gap?: number, maxWidth?: number }} [options]
 * @returns {string}
 */
export function renderTable(rows, options = {}) {
  const gap = options.gap ?? 2;
  const maxWidth = options.maxWidth ?? MAX_TABLE_WIDTH;

  const cleaned = rows
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => row.map((cell) => String(cell ?? '')));

  if (cleaned.length === 0) return '';

  const columns = Math.max(...cleaned.map((row) => row.length));
  const widths = [];
  for (let index = 0; index < columns; index += 1) {
    widths[index] = Math.max(...cleaned.map((row) => displayWidth(row[index] ?? '')));
  }

  return cleaned
    .map((row) => {
      const line = row
        .map((cell, index) =>
          index === row.length - 1 ? cell : pad(cell, widths[index] + gap),
        )
        .join('')
        .trimEnd();
      return truncate(line, maxWidth);
    })
    .join('\n');
}

/**
 * Larghezza *visiva* di una cella.
 *
 * Le emoji occupano due colonne in un font monospaziato ma contano come uno o
 * due code unit JavaScript a seconda del carattere: misurare con `.length`
 * disallineerebbe ogni riga che ne contiene una.
 *
 * @param {string} value
 */
export function displayWidth(value) {
  let width = 0;
  for (const char of String(value)) {
    width += /\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
  }
  return width;
}

function pad(value, width) {
  const missing = Math.max(0, width - displayWidth(value));
  return `${value}${' '.repeat(missing)}`;
}

/** Taglia con "…" solo se serve davvero. */
export function truncate(value, maxWidth) {
  const text = String(value);
  if (displayWidth(text) <= maxWidth) return text;

  let out = '';
  for (const char of text) {
    if (displayWidth(out) + displayWidth(char) > maxWidth - 1) break;
    out += char;
  }
  return `${out}…`;
}
