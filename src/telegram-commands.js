/**
 * Tabella comandi del bot Telegram — unica fonte di verità.
 *
 * Sta in un modulo a parte perché la stessa lista serve a due consumatori che
 * non si conoscono tra loro:
 *   - `src/telegram-poll.js`, che deve riconoscere un comando ricevuto;
 *   - `scripts/register-telegram-commands.js`, che la pubblica su Telegram con
 *     `setMyCommands` per far comparire il menu "/" nella chat.
 *
 * Se i due elenchi divergessero, il menu prometterebbe comandi che il poller
 * ignora: da qui il modulo condiviso.
 */

/**
 * @typedef {Object} BotCommand
 * @property {string}  command      Senza lo slash, minuscolo (vincolo di Telegram).
 * @property {string}  description  Testo mostrato nel menu.
 * @property {'search'|'help'} kind Cosa fa il poller quando lo riceve.
 * @property {boolean} menu         Se compare nel menu "/" della chat.
 */

/**
 * `menu: false` per gli alias: restano validi se li scrivi, ma tenerli fuori
 * dal menu evita di mostrare due voci che fanno la stessa identica cosa.
 * `/start` è obbligatorio lato Telegram (è il primo messaggio che ogni utente
 * manda premendo "Avvia") ma non ha bisogno di una riga nel menu.
 *
 * @type {BotCommand[]}
 */
export const COMMANDS = [
  { command: 'cerca', description: 'Cerca ora i voli più economici', kind: 'search', menu: true },
  { command: 'check', description: 'Alias di /cerca', kind: 'search', menu: false },
  { command: 'help', description: 'Come funziona il bot', kind: 'help', menu: true },
  { command: 'start', description: 'Messaggio di benvenuto', kind: 'help', menu: false },
];

/** Solo le voci pubblicate su Telegram, nel formato accettato da setMyCommands. */
export function menuCommands() {
  return COMMANDS.filter((entry) => entry.menu).map(({ command, description }) => ({
    command,
    description,
  }));
}

/**
 * Che tipo di comando è questo messaggio.
 *
 * Accetta la forma con menzione esplicita (`/cerca@NomeDelBot`), che Telegram
 * genera da sola nei gruppi, e ignora eventuali argomenti dopo il comando.
 *
 * @param {string} text
 * @returns {'search'|'help'|'unknown'|null} `null` se non è un comando.
 */
export function classifyCommand(text) {
  const firstToken = String(text ?? '').trim().split(/\s+/)[0] ?? '';
  if (!firstToken.startsWith('/')) return null;

  const name = firstToken.slice(1).split('@')[0].toLowerCase();
  return COMMANDS.find((entry) => entry.command === name)?.kind ?? 'unknown';
}

/** Testo di /start e /help. HTML, come le notifiche vere (`notifier.js`). */
export function helpMessage() {
  const menu = COMMANDS.filter((entry) => entry.menu)
    .map((entry) => `/${entry.command} — ${entry.description.toLowerCase()}`)
    .join('\n');

  return [
    '👋 Sono il bot di <b>looking-for-flights</b>.',
    '',
    'Controllo il prezzo dei voli A/R verso le mete in lista <b>due volte al giorno</b> (mattina e sera) e ti scrivo solo quando c\'è una variazione che vale la pena sapere.',
    '',
    '<b>Comandi</b>',
    menu,
    '',
    '⏱ La ricerca su richiesta <b>non è istantanea</b>: leggo i messaggi ogni 15 minuti circa, poi la ricerca vera richiede qualche minuto. Ti mando un ack appena parte.',
  ].join('\n');
}

/** Risposta a uno slash-command che non esiste. @param {string} text */
export function unknownCommandMessage(text) {
  const shown = String(text ?? '').trim().split(/\s+/)[0]?.slice(0, 32) ?? '';
  const available = COMMANDS.filter((entry) => entry.menu)
    .map((entry) => `/${entry.command}`)
    .join(', ');

  return `❓ Non conosco <code>${escapeHtml(shown)}</code>. Comandi disponibili: ${available}`;
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Invio "best effort" di un messaggio: non lancia mai.
 *
 * Chi la chiama sta rispondendo a un comando, non consegnando la notifica
 * vera e propria (quella è `notifier.js`): se Telegram rifiuta, un warning
 * basta — la ricerca non deve fermarsi per un ack perso.
 *
 * @param {string} token
 * @param {string|number} chatId
 * @param {string} html
 * @returns {Promise<boolean>} `true` se Telegram ha accettato il messaggio.
 */
export async function sendMessage(token, chatId, html) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok || payload?.ok === false) {
      console.warn(`⚠️  Messaggio Telegram non inviato: ${payload?.description ?? `HTTP ${response.status}`}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`⚠️  Messaggio Telegram non inviato: ${error.message}`);
    return false;
  }
}

/**
 * Pubblica il menu comandi su Telegram (idempotente: riscrive la lista intera).
 *
 * @param {string} token
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function registerCommands(token) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: menuCommands() }),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok || payload?.ok === false) {
      return { ok: false, error: payload?.description ?? `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
