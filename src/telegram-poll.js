#!/usr/bin/env node
/**
 * "Ascolto" per i comandi Telegram — la metà mancante rispetto a `notifier.js`,
 * che sa solo mandare messaggi, non riceverli.
 *
 * Il bot Telegram non riceve mai un webhook qui (non c'è un server sempre
 * acceso): questo script viene invocato da un cron di GitHub Actions ogni
 * pochi minuti e usa `getUpdates` per chiedere a Telegram "cos'è successo
 * da quando ho controllato l'ultima volta".
 *
 * Stato persistito in data/telegram_offset.json: l'`update_id` più alto già
 * processato, così un comando non fa mai scattare due ricerche.
 *
 * I comandi riconosciuti sono in `src/telegram-commands.js`, condivisi con lo
 * script che pubblica il menu "/" su Telegram. Ricevuto un comando nella chat
 * autorizzata, questo script:
 *   - `/cerca`, `/check` → manda un ack ("🔍 Ricerca avviata...") così l'attesa
 *     non è muta, e scrive `triggered=true` in $GITHUB_OUTPUT, letto dal
 *     workflow per decidere se lanciare `npm start` subito dopo;
 *   - `/start`, `/help`  → risponde con le istruzioni, senza cercare nulla;
 *   - altri slash-command → risponde che non esistono, elencando quelli veri.
 *
 * Un comando sconosciuto merita risposta quanto uno valido: un bot che tace
 * sembra rotto, ed è esattamente il dubbio che fa riscrivere il comando a
 * vuoto. Il testo libero invece resta ignorato — la chat deve poter essere
 * usata anche per appunti senza che il bot risponda a ogni riga.
 *
 * Non lancia il monitor direttamente: resta un solo punto d'ingresso
 * (`src/index.js`), identico per cron giornaliero, run manuale e comando
 * Telegram.
 */

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyCommand,
  helpMessage,
  sendMessage,
  unknownCommandMessage,
} from './telegram-commands.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'data', 'telegram_offset.json');

async function loadOffset(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'));
    return Number.isFinite(Number(parsed.lastUpdateId)) ? Number(parsed.lastUpdateId) : 0;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`⚠️  Stato offset illeggibile (${error.message}). Riparto da 0.`);
    }
    return 0;
  }
}

async function saveOffset(statePath, lastUpdateId) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ lastUpdateId }, null, 2)}\n`, 'utf8');
}

/** Scrive per il workflow GitHub Actions; no-op se lanciato in locale. */
async function setActionOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  await appendFile(outputPath, `${name}=${value}\n`, 'utf8');
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error('❌ TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID mancanti: impossibile ascoltare comandi.');
    return 1;
  }

  const lastUpdateId = await loadOffset(STATE_PATH);

  const response = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=0`,
  );
  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.ok) {
    console.error(`❌ Telegram getUpdates fallita: ${payload?.description ?? `HTTP ${response.status}`}`);
    return 1;
  }

  const updates = payload.result ?? [];

  if (updates.length === 0) {
    console.log('➖ Nessun messaggio nuovo.');
    await setActionOutput('triggered', 'false');
    return 0;
  }

  let maxUpdateId = lastUpdateId;
  let triggered = false;
  let wantsHelp = false;
  /** Il primo comando sconosciuto del lotto: si risponde una volta sola. */
  let unknown = null;

  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id);

    const message = update.message;
    if (!message || String(message.chat?.id) !== String(chatId)) continue;

    const text = String(message.text ?? '');

    switch (classifyCommand(text)) {
      case 'search':
        console.log(`✅ Comando "${text}" ricevuto — avvio ricerca.`);
        triggered = true;
        break;
      case 'help':
        console.log(`ℹ️  Comando "${text}" ricevuto — rispondo con le istruzioni.`);
        wantsHelp = true;
        break;
      case 'unknown':
        console.log(`❓ Comando "${text}" sconosciuto.`);
        unknown ??= text;
        break;
      default:
        break; // Testo libero: nessuna risposta.
    }
  }

  // Prima l'offset, poi le risposte: se l'invio fallisce si perde un messaggio,
  // mentre l'ordine inverso rischierebbe di rieseguire il comando al giro dopo.
  await saveOffset(STATE_PATH, maxUpdateId);

  // Se nello stesso lotto c'è sia /cerca sia /help, l'ack va per primo: è la
  // risposta al comando che ha davvero avviato qualcosa.
  if (triggered) await sendMessage(token, chatId, '🔍 Ricerca avviata, risultati a breve...');
  if (wantsHelp) await sendMessage(token, chatId, helpMessage());
  // Un comando inesistente accanto a uno valido è quasi sempre un refuso già
  // corretto: rispondere "non esiste" aggiungerebbe solo rumore.
  if (unknown && !triggered && !wantsHelp) {
    await sendMessage(token, chatId, unknownCommandMessage(unknown));
  }

  console.log(triggered ? '🔔 Trigger rilevato.' : '➖ Nessuna ricerca da avviare.');
  await setActionOutput('triggered', String(triggered));
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`❌ Errore fatale: ${error.message}`);
    process.exitCode = 1;
  });
