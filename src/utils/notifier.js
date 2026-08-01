/**
 * Notification layer: Telegram Bot API with optional Slack Incoming Webhook.
 *
 * Both channels are optional and independent. A channel is "configured" when
 * its credentials are present in the environment; unconfigured channels are
 * skipped silently, and a failure on one channel never prevents the other from
 * being tried. `sendNotification` never throws — it reports per-channel
 * outcomes so the caller can decide what to do with a partial delivery.
 */

const TELEGRAM_MAX_CHARS = 4096;
const SLACK_MAX_CHARS = 39000;

/**
 * @typedef {Object} ChannelResult
 * @property {string}      channel
 * @property {'sent'|'skipped'|'failed'} status
 * @property {string}      [reason]
 */

/**
 * Which channels have usable credentials in this environment.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function availableChannels(env = process.env) {
  const channels = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) channels.push('telegram');
  if (env.SLACK_WEBHOOK_URL) channels.push('slack');
  return channels;
}

/**
 * Deliver a message to every enabled and configured channel.
 *
 * @param {{ html: string, text: string }} message  Pre-rendered payloads.
 * @param {{ channels?: string[], env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ delivered: boolean, results: ChannelResult[] }>}
 */
export async function sendNotification(message, options = {}) {
  const env = options.env ?? process.env;
  const enabled = options.channels ?? ['telegram', 'slack'];

  /** @type {ChannelResult[]} */
  const results = [];

  if (enabled.includes('telegram')) {
    results.push(await sendTelegram(message.html, env));
  }
  if (enabled.includes('slack')) {
    results.push(await sendSlack(message.text, env));
  }

  return {
    delivered: results.some((result) => result.status === 'sent'),
    results,
  };
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

/**
 * @param {string} html
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<ChannelResult>}
 */
async function sendTelegram(html, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return { channel: 'telegram', status: 'skipped', reason: 'TELEGRAM_BOT_TOKEN/CHAT_ID assenti' };
  }

  const chunks = splitMessage(html, TELEGRAM_MAX_CHARS);

  try {
    for (const chunk of chunks) {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok || payload?.ok === false) {
        const detail = payload?.description ?? `HTTP ${response.status}`;
        return { channel: 'telegram', status: 'failed', reason: detail };
      }
    }
    return { channel: 'telegram', status: 'sent' };
  } catch (error) {
    return { channel: 'telegram', status: 'failed', reason: error.message };
  }
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<ChannelResult>}
 */
async function sendSlack(text, env) {
  const webhookUrl = env.SLACK_WEBHOOK_URL;

  if (!webhookUrl) {
    return { channel: 'slack', status: 'skipped', reason: 'SLACK_WEBHOOK_URL assente' };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, SLACK_MAX_CHARS) }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        channel: 'slack',
        status: 'failed',
        reason: `HTTP ${response.status} ${detail}`.trim(),
      };
    }
    return { channel: 'slack', status: 'sent' };
  } catch (error) {
    return { channel: 'slack', status: 'failed', reason: error.message };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape the five characters Telegram's HTML parser cares about. */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Split on line boundaries so an HTML tag is never cut in half.
 * A single over-long line is hard-split as a last resort.
 * @param {string} message
 * @param {number} limit
 * @returns {string[]}
 */
export function splitMessage(message, limit) {
  if (message.length <= limit) return [message];

  const chunks = [];
  let current = '';

  for (const line of message.split('\n')) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }

    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }

  if (current) chunks.push(current);
  return balancePreBlocks(chunks);
}

/**
 * Richiude i `<pre>` rimasti aperti da un taglio, e li riapre nel pezzo dopo.
 *
 * Telegram rifiuta l'**intero** messaggio se il markup non è bilanciato: con
 * le tabelle, un taglio a metà blocco non produce una tabella brutta ma
 * *nessuna notifica*, con un errore `can't parse entities` difficile da
 * ricondurre alla causa.
 *
 * Contare quanti tag aperti e chiusi ci sono nel pezzo non basta: un pezzo può
 * contenere un `</pre>` orfano all'inizio *e* un `<pre>` orfano alla fine, e i
 * conteggi tornerebbero pari nascondendo due rotture. Va guardato l'**ordine**
 * dei tag, portandosi dietro lo stato da un pezzo al successivo.
 *
 * @param {string[]} chunks
 */
function balancePreBlocks(chunks) {
  let insidePre = false;

  return chunks.map((chunk) => {
    let out = insidePre ? `<pre>${chunk}` : chunk;

    let open = false;
    for (const tag of out.match(/<\/?pre>/g) ?? []) open = tag === '<pre>';

    if (open) out = `${out}</pre>`;
    insidePre = open;
    return out;
  });
}
