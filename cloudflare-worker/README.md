# Webhook Telegram — Cloudflare Worker

Fa partire `/cerca` **all'istante**, invece che aspettare il prossimo giro del
polling GitHub (che nella pratica arrivava a 26-42 minuti — vedi
[history.md](../history.md), *"Ogni 15 minuti" non era vero*).

## Perché esiste questo file separato

Il resto del progetto vive tutto dentro GitHub Actions, di proposito: zero
account esterni da mantenere. Ma GitHub Actions non ha modo di accorgersi che
hai scritto qualcosa a un bot Telegram se non **controllando a intervalli** —
non può restare in ascolto 24 ore su 24 di sua iniziativa. Un vero "zero
attesa" richiede qualcosa di raggiungibile via HTTPS in ogni istante, pronto a
ricevere l'avviso di Telegram nel momento esatto in cui arriva. GitHub Actions
non può esserlo; un Cloudflare Worker sì — ed è gratuito, senza carta di
credito, con un solo file JS da pubblicare.

Questo è l'**unico** pezzo del progetto che vive fuori da GitHub. Se preferisci
non aggiungere questa dipendenza, `/cerca` funziona comunque tramite il
pulsante "Run workflow" su GitHub — semplicemente non istantaneo.

## Come funziona

```
Scrivi /cerca al bot
        │
        ▼
Telegram chiama il Worker (webhook, HTTPS, istantaneo)
        │
        ├─ non è la chat autorizzata? ──▶ ignorato, 200 OK
        ├─ comando /help o sconosciuto? ──▶ risponde subito, nessun dispatch
        └─ /cerca o /check ──▶ 🔍 ack immediato
                                + chiama workflow_dispatch su monitor.yml
                                    (force_notify=true)
                                        │
                                        ▼
                              GitHub Actions esegue la ricerca vera,
                              con lo stesso snapshot, soglie e avviso
                              di fallimento del cron giornaliero.
```

Il Worker non cerca voli: fa solo da "citofono" istantaneo tra Telegram e
GitHub. La logica di ricerca resta un'unica fonte di verità in
[src/index.js](../src/index.js).

## Cosa serve prima di iniziare

- Un account Cloudflare gratuito: [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) — nessuna carta di credito richiesta per i Workers sul piano free.
- Node.js già installato (lo stesso richiesto dal resto del progetto).
- Il token e il chat id di Telegram che hai già configurato come GitHub Secrets — servono di nuovo qui, perché il Worker gira fuori da GitHub e non li eredita.

## 1. Installa Wrangler e fai login

Dalla cartella `cloudflare-worker/`:

```bash
cd cloudflare-worker
npm install
npx wrangler login
```

Si apre il browser per autorizzare Wrangler sul tuo account Cloudflare.

## 2. Crea un token GitHub per il Worker

Il Worker deve poter chiamare `workflow_dispatch` su questo repository — gli
serve un token GitHub **dedicato**, diverso da quelli che usi tu.

**[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)** (fine-grained, non classic):

- **Repository access**: *Only select repositories* → scegli questo repo, nessun altro.
- **Permissions** → **Actions**: **Read and write**. Tutto il resto: *No access*.
- Genera e copia il token (`github_pat_...`): non sarà più visibile dopo.

Un token con questo scope può far partire workflow su questo repo e nient'altro — non può leggere codice, non può scrivere issue, non può toccare altri repository.

## 3. Genera un secret per il webhook

Una stringa a caso, che userai sia qui sia quando registri il webhook su
Telegram (serve a Telegram per dimostrare che è davvero lui a chiamare il
Worker, non un estraneo che ha indovinato l'URL):

```bash
openssl rand -hex 32
```

(su Windows senza `openssl`: usa un generatore di password qualsiasi, basta che sia lungo e casuale)

## 4. Configura i secret del Worker

Ognuno di questi comandi chiede il valore in modo interattivo (non finisce nella shell history):

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GITHUB_REPO
```

Per `GITHUB_REPO` incolla `utente/nome-repo` (es. `julioojospintados/looking-for-flights`).

## 5. Pubblica il Worker

```bash
npx wrangler deploy
```

L'output mostra l'URL pubblico, tipo:

```
https://looking-for-flights-telegram-webhook.<tuo-account>.workers.dev
```

Copialo: serve al passo successivo.

## 6. Registra il webhook su Telegram

Un'unica chiamata, da fare una volta sola (sostituisci `<BOT_TOKEN>`, `<URL_WORKER>` e `<SECRET>` con i tuoi valori — lo stesso `<SECRET>` del passo 3):

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "<URL_WORKER>", "secret_token": "<SECRET>"}'
```

Risposta attesa: `{"ok":true,"result":true,"description":"Webhook was set"}`.

> ⚠️ Impostare un webhook disattiva `getUpdates` (il polling): i due modi non possono coesistere. Non è un problema qui, perché il polling era già stato ritirato — ma se in futuro reintroduci una Action che chiama `getUpdates`, smetterebbe di ricevere aggiornamenti finché il webhook resta attivo.

## 7. Verifica

Scrivi `/cerca` al bot. Dovresti ricevere l'ack "🔍 Ricerca avviata..." nel giro di secondi, non minuti. Poi controlla **Actions** su GitHub: dovrebbe comparire un run di "Flight Price Monitor" appena partito.

Se non succede nulla:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Il campo `last_error_message`, se presente, dice cosa non ha funzionato lato Telegram (es. secret sbagliato, URL non raggiungibile).

## Aggiornare il Worker

Dopo ogni modifica a `src/worker.js`:

```bash
npx wrangler deploy
```

Nessuna ripubblicazione del webhook necessaria: l'URL resta lo stesso.

## Tornare al solo pulsante GitHub (rimuovere il Worker)

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/deleteWebhook"
npx wrangler delete
```

`/cerca` scritto in chat torna a non fare nulla (nessun listener attivo); resta comunque il pulsante **Actions → Flight Price Monitor → Run workflow**.
