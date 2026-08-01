#!/usr/bin/env node
/**
 * Pubblica il menu comandi del bot su Telegram (`setMyCommands`).
 *
 * È l'equivalente via API di `/setcommands` su @BotFather: dopo averlo
 * eseguito, nella chat col bot compare il pulsante "/" con la lista dei
 * comandi e la loro descrizione, invece di doverli ricordare a memoria.
 *
 * Va lanciato **una volta sola**, e di nuovo solo quando la lista in
 * `src/telegram-commands.js` cambia — non è un passo del cron: il menu è
 * uno stato che vive su Telegram, non nel repo, e riscriverlo a ogni poll
 * sarebbero ~96 chiamate al giorno per non cambiare nulla.
 *
 * Uso:
 *   TELEGRAM_BOT_TOKEN=... node scripts/register-telegram-commands.js
 *   npm run telegram:commands
 *
 * Oppure senza avere il token in locale: Actions → "Telegram On-Demand
 * Search" → "Run workflow" con `register_commands` = true.
 */

import { menuCommands, registerCommands } from '../src/telegram-commands.js';

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    console.error('❌ TELEGRAM_BOT_TOKEN mancante: impossibile registrare i comandi.');
    return 1;
  }

  const commands = menuCommands();
  const result = await registerCommands(token);

  if (!result.ok) {
    console.error(`❌ setMyCommands fallita: ${result.error}`);
    return 1;
  }

  console.log('✅ Menu comandi aggiornato su Telegram:');
  for (const { command, description } of commands) {
    console.log(`   /${command} — ${description}`);
  }
  console.log('\nIl menu "/" compare nella chat col bot (riapri la chat se non lo vedi subito).');
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
