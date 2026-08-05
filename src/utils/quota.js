/**
 * Contatore di consumo API che sopravvive ai run.
 *
 * `sampling.maxApiCallsPerRun` limita la singola esecuzione, e non ha mai
 * impedito nulla: dieci `/cerca` in un pomeriggio sono dieci run legittimi da
 * 60 ricerche l'uno. Il tetto che serviva è quello che attraversa i run, cioè
 * questo — l'unico che conosce la differenza fra "questa ricerca è cara" e
 * "questo mese è finito".
 *
 * ## Finestra mobile, non mese solare
 *
 * SerpApi azzera il contatore all'anniversario dell'iscrizione, non il primo
 * del mese, e quella data non è nota al programma. Contare su una **finestra
 * mobile di 30 giorni** evita di doverla sapere: è leggermente conservativo
 * (a cavallo del rinnovo vede ancora il consumo vecchio) e sbaglia quindi
 * sempre dalla parte giusta — bloccare un run in più è recuperabile, sforare
 * la quota no.
 *
 * ## Riserva per le ricerche su richiesta
 *
 * Il cron e `/cerca` non valgono uguale: il cron può saltare un giro senza
 * che nessuno se ne accorga, un `/cerca` è una persona che sta aspettando.
 * Le esecuzioni programmate si fermano quindi prima, lasciando intatta una
 * riserva che solo le richieste esplicite possono intaccare.
 */

const DEFAULT_WINDOW_DAYS = 30;

/**
 * @typedef {Object} QuotaConfig
 * @property {number} monthlySearches      Tetto del piano API.
 * @property {number} [reserveForOnDemand] Quota che il cron non può toccare.
 * @property {number} [windowDays]         Ampiezza della finestra mobile.
 *
 * @typedef {Object} QuotaState
 * @property {Array<{ date: string, calls: number }>} window  Consumo per giorno.
 */

/** Stato vuoto, usato alla prima esecuzione e quando il file è illeggibile. */
export function emptyQuotaState() {
  return { window: [] };
}

/**
 * Ricerche consumate nella finestra che termina oggi.
 *
 * @param {QuotaState|null|undefined} state
 * @param {string} today  YYYY-MM-DD
 * @param {number} [windowDays]
 */
export function usageInWindow(state, today, windowDays = DEFAULT_WINDOW_DAYS) {
  const from = shiftDate(today, -(windowDays - 1));

  return (state?.window ?? [])
    .filter((entry) => entry.date >= from && entry.date <= today)
    .reduce((sum, entry) => sum + (Number(entry.calls) || 0), 0);
}

/**
 * Registra il consumo di un run, accorpandolo al giorno e potando lo storico.
 *
 * Le voci più vecchie della finestra vengono eliminate invece di accumularsi:
 * il file è committato in git a ogni run, e uno storico che cresce all'infinito
 * ne farebbe crescere il diff per sempre.
 *
 * @param {QuotaState|null|undefined} state
 * @param {string} date   YYYY-MM-DD
 * @param {number} calls
 * @param {number} [windowDays]
 * @returns {QuotaState}
 */
export function recordUsage(state, date, calls, windowDays = DEFAULT_WINDOW_DAYS) {
  const amount = Math.max(0, Number(calls) || 0);
  const kept = (state?.window ?? []).filter((entry) => entry.date >= shiftDate(date, -(windowDays - 1)));

  const existing = kept.find((entry) => entry.date === date);
  if (existing) existing.calls += amount;
  else kept.push({ date, calls: amount });

  kept.sort((a, b) => a.date.localeCompare(b.date));
  return { window: kept };
}

/**
 * Quante ricerche questo run può ancora fare.
 *
 * @param {QuotaConfig} config
 * @param {number} used                     Consumo nella finestra.
 * @param {'scheduled'|'ondemand'} mode
 * @returns {{ allowed: number, cap: number, used: number, exhausted: boolean, mode: string }}
 */
export function remainingAllowance(config, used, mode) {
  const monthly = Number(config?.monthlySearches);
  // Nessun tetto configurato = nessun limite: il contatore osserva e basta,
  // non inventa un limite che l'utente non ha dichiarato.
  if (!Number.isFinite(monthly) || monthly <= 0) {
    return { allowed: Infinity, cap: Infinity, used, exhausted: false, mode };
  }

  const reserve = Math.max(0, Number(config?.reserveForOnDemand) || 0);
  const cap = mode === 'ondemand' ? monthly : Math.max(0, monthly - reserve);
  const allowed = Math.max(0, cap - used);

  return { allowed, cap, used, exhausted: allowed <= 0, mode };
}

/** Giorno in cui la finestra tornerà a liberare spazio. @param {QuotaState} state */
export function nextReleaseDate(state, windowDays = DEFAULT_WINDOW_DAYS) {
  const oldest = (state?.window ?? []).map((entry) => entry.date).sort()[0];
  return oldest ? shiftDate(oldest, windowDays) : null;
}

/** @param {string} isoDate @param {number} days */
function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Data odierna in UTC, l'unico fuso usato dallo stato. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}
