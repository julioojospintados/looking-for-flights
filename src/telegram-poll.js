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
 * Se un messaggio nella chat autorizzata contiene uno dei comandi in
 * TRIGGER_COMMANDS, questo script:
 *   1. manda subito un ack ("🔍 Ricerca avviata...") così l'attesa non è muta;
 *   2. scrive `triggered=true` in $GITHUB_OUTPUT, letto dal workflow per
 *      decidere se lanciare `npm start` subito dopo.
 *
 * Non lancia il monitor direttamente: resta un solo punto d'ingresso
 * (`src/index.js`), identico per cron giornaliero, run manuale e comando
 * Telegram.
 */

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(ROOT, 'data', 'telegram_offset.json');

/** Case-insensitive; "/cerca@NomeDelBot" (menzione esplicita) è accettato. */
const TRIGGER_COMMANDS = ['/cerca', '/check'];

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

/** @param {string} text */
function matchesTrigger(text) {
  const normalised = text.trim().toLowerCase();
  return TRIGGER_COMMANDS.some((cmd) => normalised === cmd || normalised.startsWith(`${cmd}@`));
}

async function sendAck(token, chatId) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '🔍 Ricerca avviata, risultati a breve...',
      }),
    });
  } catch (error) {
    // Un ack mancato non deve bloccare la ricerca vera: solo un warning.
    console.warn(`⚠️  Ack Telegram non inviato: ${error.message}`);
  }
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

  for (const update of updates) {
    maxUpdateId = Math.max(maxUpdateId, update.update_id);

    const message = update.message;
    if (!message || String(message.chat?.id) !== String(chatId)) continue;

    const text = String(message.text ?? '');
    if (matchesTrigger(text)) {
      console.log(`✅ Comando "${text}" ricevuto — avvio ricerca.`);
      triggered = true;
    }
  }

  await saveOffset(STATE_PATH, maxUpdateId);

  if (triggered) await sendAck(token, chatId);

  console.log(triggered ? '🔔 Trigger rilevato.' : '➖ Nessun comando riconosciuto tra i nuovi messaggi.');
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
