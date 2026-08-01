/**
 * Webhook Telegram → GitHub Actions, per una notifica di /cerca davvero
 * istantanea invece che ogni 15-45 minuti.
 *
 * Perché esiste: GitHub Actions non ha modo di sapere che hai scritto
 * qualcosa se non controllando a intervalli (`getUpdates`), e quegli
 * intervalli, misurati su una giornata reale, arrivavano a 26-42 minuti
 * (vedi history.md, "Ogni 15 minuti non era vero"). Un webhook capovolge il
 * flusso: Telegram avvisa QUESTO worker nell'istante in cui scrivi, e il
 * worker fa partire GitHub subito — zero attesa strutturale, non solo un
 * intervallo più corto.
 *
 * Perché un Worker e non un'altra Action: serve qualcosa raggiungibile via
 * HTTPS 24/7 per ricevere il webhook. GitHub Actions non espone un endpoint
 * del genere; un runner esiste solo mentre un job gira. Questo è l'unico
 * pezzo del progetto che vive fuori da GitHub — vedi cloudflare-worker/README.md
 * per il perché di quella scelta specifica e i costi.
 *
 * Il worker NON esegue la ricerca: chiama `workflow_dispatch` sullo stesso
 * monitor.yml del cron giornaliero, con force_notify=true. Nessuna logica di
 * ricerca duplicata; snapshot, soglie di notifica, avviso di fallimento su
 * Telegram restano quelli di sempre, un solo punto di verità.
 *
 * Import diretto da src/telegram-commands.js: quel modulo usa solo `fetch` e
 * API standard (nessun modulo `node:*`), quindi gira identico su Node e sul
 * runtime V8 isolato di Workers. Stessa tabella comandi, stesso testo di
 * aiuto, un solo posto dove i comandi sono definiti — non due copie che
 * possono divergere.
 */

import {
  classifyCommand,
  helpMessage,
  sendMessage,
  unknownCommandMessage,
} from '../../src/telegram-commands.js';

/**
 * @typedef {Object} Env
 * @property {string} TELEGRAM_BOT_TOKEN
 * @property {string} TELEGRAM_CHAT_ID       Unica chat autorizzata a far partire ricerche.
 * @property {string} TELEGRAM_WEBHOOK_SECRET Deve combaciare con l'header che manda Telegram.
 * @property {string} GITHUB_TOKEN           PAT con permesso Actions: Read and write sul repo.
 * @property {string} GITHUB_REPO            "utente/nome-repo".
 * @property {string} [GITHUB_REF]           Branch da lanciare. Default: "main".
 */

const GITHUB_API = 'https://api.github.com';

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('OK — questo endpoint accetta solo il webhook POST di Telegram.', { status: 200 });
    }

    // Chiunque conosca l'URL del Worker potrebbe altrimenti mandare update
    // falsi: Telegram allega questo header solo se il webhook è stato
    // registrato con lo stesso secret_token (vedi setWebhook nel README).
    const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!env.TELEGRAM_WEBHOOK_SECRET || secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    const update = await request.json().catch(() => null);
    const message = update?.message;

    // Rispondere comunque 200: un 4xx/5xx qui fa ritentare la consegna a
    // Telegram, e "niente da fare" (chat sbagliata, update senza messaggio)
    // non è un errore.
    if (!message || String(message.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) {
      return new Response('OK', { status: 200 });
    }

    const text = String(message.text ?? '');
    const kind = classifyCommand(text);

    if (kind === 'search') {
      console.log(`✅ Comando "${text}" ricevuto — avvio ricerca su GitHub.`);
      // Prima l'ack, poi il dispatch: se GitHub rifiutasse la richiesta hai
      // comunque la conferma che il comando è arrivato, non un silenzio.
      await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, '🔍 Ricerca avviata, risultati a breve...');
      await dispatchSearch(env);
    } else if (kind === 'help') {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, helpMessage());
    } else if (kind === 'unknown') {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, unknownCommandMessage(text));
    }
    // Testo libero (kind === null): nessuna risposta, come nel poller originale.

    return new Response('OK', { status: 200 });
  },
};

/**
 * Fa partire monitor.yml con `workflow_dispatch`, lo stesso trigger del
 * pulsante "Run workflow". Se GitHub rifiuta la richiesta (token scaduto,
 * nome repo sbagliato) lo dice subito via Telegram: un ack senza esito è
 * peggio di nessun ack (lo stesso principio già applicato nel resto del
 * progetto per i fallimenti del monitor stesso).
 *
 * @param {Env} env
 */
async function dispatchSearch(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID,
      '❌ Configurazione del Worker incompleta: manca GITHUB_TOKEN o GITHUB_REPO.',
    );
    return;
  }

  try {
    const response = await fetch(
      `${GITHUB_API}/repos/${env.GITHUB_REPO}/actions/workflows/monitor.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'looking-for-flights-telegram-webhook',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: env.GITHUB_REF || 'main',
          inputs: { force_notify: 'true' },
        }),
      },
    );

    // workflow_dispatch risponde 204 senza corpo quando va a buon fine.
    if (response.status !== 204) {
      const detail = await response.text().catch(() => '');
      await sendMessage(
        env.TELEGRAM_BOT_TOKEN,
        env.TELEGRAM_CHAT_ID,
        `❌ GitHub ha rifiutato l'avvio della ricerca (HTTP ${response.status}). ${detail.slice(0, 300)}`,
      );
    }
  } catch (error) {
    await sendMessage(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID,
      `❌ Impossibile contattare GitHub per avviare la ricerca: ${error.message}`,
    );
  }
}
