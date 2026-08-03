# ✈️ Looking for Flights

Monitoraggio automatico dei prezzi dei voli con **classifica per giorni di viaggio sostenibili a budget fisso**.

Due volte a settimana una GitHub Action cerca il volo A/R più economico verso ogni destinazione candidata, calcola quanti giorni potresti restare a terra con il budget residuo, ordina le destinazioni e ti scrive su Telegram **solo quando c'è davvero qualcosa da sapere** — oppure scrivi `/cerca` al bot per farla partire quando vuoi tu.

> **Architettura "Engine + Config"** — tutta la logica di dominio vive in [config/trips.json](config/trips.json). Per monitorare un viaggio completamente diverso (altre date, altro budget, altre destinazioni) non si tocca una riga di codice.

---

## 📑 Indice

- [Come funziona](#-come-funziona)
- [Struttura del progetto](#-struttura-del-progetto)
- [Setup passo-passo](#-setup-passo-passo)
- [Esecuzione locale](#-esecuzione-locale)
- [Ricerca su richiesta: comando /cerca su Telegram](#ricerca-su-richiesta-comando-cerca-su-telegram)
  - [Comandi del bot](#comandi-del-bot)
- [Riferimento configurazione](#-riferimento-configurazione)
  - [Budget: privato anche a repo pubblico](#budget-privato-anche-a-repo-pubblico)
  - [Scadenza sul rientro (returnBy)](#scadenza-sul-rientro-returnby)
  - [Prezzo per aeroporto di partenza (originGroups)](#prezzo-per-aeroporto-di-partenza-origingroups)
  - [Formato della notifica](#formato-della-notifica)
- [Consumo della quota API](#-consumo-della-quota-api-leggimi)
- [Cambiare provider](#-cambiare-provider)
- [Troubleshooting](#-troubleshooting)

---

## 🧠 Come funziona

### Il vincolo sulla durata

Il viaggio deve durare **tra 14 e 21 giorni**. Non è un'indicazione, è un vincolo rigido, applicato in due punti:

1. **Sul volo** — vengono cercati solo andata/ritorno la cui durata cade nella finestra, e qualsiasi risultato che torni fuori range viene scartato prima di entrare in classifica.
2. **Sul budget** — i giorni sostenibili sono tagliati a 21: giorni che il budget pagherebbe ma il viaggio non può usare non sono giorni veri.

### La formula

Per ogni destinazione candidata, dato il volo A/R più economico trovato:

```
budgetPerTerra = budgetTotale − prezzoVolo − extraFisso
giorniBudget   = floor(budgetPerTerra / spesaGiornaliera)   ← teorici
giorni         = min(giorniBudget, durataMax)               ← utilizzabili

costoTotale(N) = prezzoVolo + extraFisso + N × spesaGiornaliera
```

La classifica è ordinata per **`giorni` decrescente**, con il **costo totale crescente** come spareggio.

> ⚠️ **Conseguenza del cap**: quando più mete hanno budget sufficiente per il viaggio pieno, arrivano tutte a `21/21` e la classifica finisce decisa interamente dallo spareggio sul costo. È il comportamento corretto — a 21 giorni pieni la domanda non è più "quanto posso restare" ma "quanto mi avanza" — ma è utile saperlo quando leggi la notifica.

Esempio con prezzi reali (31 lug 2026):

| Destinazione | Volo A/R | Spesa/gg | Extra | Giorni | Totale 21 gg |
|---|---|---|---|---|---|
| 🥇 India (DEL) | 506,40 € | 20 € | 0 € | **21/21** | 926,40 € |
| 🥈 Indonesia (CGK) | 468,80 € | 27 € | 70 € | **21/21** | 1105,80 € |
| 🥉 Vietnam (SGN) | 502,95 € | 27 € | 60 € | **21/21** | 1129,95 € |
| 4 Malesia (KUL) | 512,53 € | 33 € | 0 € | **21/21** | 1205,53 € |
| 5 Thailandia (BKK) | 546,43 € | 30 € | 55 € | **21/21** | 1231,43 € |

Il volo più economico è Giacarta, ma vince l'India perché costa 7 €/giorno in meno a terra: **la spesa giornaliera pesa più del volo**. Quando il budget non basta per i 21 giorni pieni, la notifica lo dice: `10/21 gg (budget insufficiente per 21)`.

> Né la notifica né questo README mostrano mai il budget stesso, i giorni "teorici" (`giorniBudget`, non tagliati a 21) o il margine residuo: combinati con spesa/gg e volo — entrambi pubblici — rivelerebbero il budget esatto. È per questo che il budget non vive in `config/trips.json`: vedi [Budget: privato anche a repo pubblico](#budget-privato-anche-a-repo-pubblico).

### Quando arriva la notifica

Il sistema è volutamente silenzioso. Notifica **solo** se:

| # | Condizione | Perché |
|---|---|---|
| **a** | Prima esecuzione (nessuno snapshot precedente) | Ti dà la baseline di partenza |
| **b** | Il vincitore della classifica è cambiato | La decisione di viaggio cambia |
| **c** | Un volo è sceso di **≥ 15 €** | Vale la pena guardare |

In tutti gli altri casi il run gira, aggiorna lo snapshot se i numeri sono cambiati, e non ti disturba.

### Il ciclo

```
lun e gio 07:00 UTC ─▶ GitHub Action
                │
                ├─▶ legge config/trips.json
                ├─▶ interroga il provider voli (SerpApi / Amadeus)
                ├─▶ calcola giorni max e classifica
                ├─▶ confronta con data/last_prices.json
                │     ├─ variazione rilevante? ──▶ 📲 Telegram / Slack
                │     └─ numeri cambiati?      ──▶ 💾 aggiorna lo snapshot
                └─▶ commit automatico "chore: update flight price snapshot [skip ci]"
```

---

## 📂 Struttura del progetto

```text
.
├── .github/workflows/
│   ├── monitor.yml                 # Cron lun+gio, trigger manuale, dispatch dal webhook
│   └── telegram-admin.yml          # Utility manuale: pubblica il menu "/" del bot
├── cloudflare-worker/               # Unico pezzo fuori da GitHub — vedi il suo README
│   ├── src/worker.js               # Webhook Telegram → workflow_dispatch, istantaneo
│   ├── wrangler.toml
│   └── README.md                   # Guida di deploy passo-passo
├── config/
│   ├── trips.json                  # ⭐ L'unico file da modificare per un nuovo viaggio
│   └── mete.txt                    # Via rapida per aggiungere/togliere destinazioni
├── data/last_prices.json           # Stato prezzi (committato dalla Action)
├── scripts/
│   ├── sync-mete.js                # Applica config/mete.txt a config/trips.json
│   └── register-telegram-commands.js  # Pubblica il menu "/" del bot (setMyCommands)
├── src/
│   ├── api/
│   │   ├── flightProvider.js       # Contratto generico + factory + HTTP con retry
│   │   ├── serpapi.js              # Implementazione SerpApi (Google Flights)
│   │   ├── amadeus.js              # Implementazione Amadeus Self-Service
│   │   └── mock.js                 # Provider offline per test (nessuna quota consumata)
│   ├── utils/
│   │   ├── notifier.js             # Telegram + Slack
│   │   ├── quota.js                # Tetto API che attraversa i run
│   │   ├── airports.js             # IATA → città (TRN → Torino)
│   │   └── format.js               # Durate, orari, tabelle monospaziate
│   ├── engine.js                   # Piano di ricerca, budget, classifica
│   ├── index.js                    # Entry point: stato, delta, rendering, notifica
│   └── telegram-commands.js        # Tabella comandi del bot — unica fonte di verità,
│                                    # importata sia da qui sia dal Worker
├── history.md                      # Perché, non cosa — il diff non lo racconta
├── .env.example
└── package.json                    # Zero dipendenze runtime (lato GitHub Actions)
```

**Zero dipendenze**: il progetto usa solo la standard library di Node 22+ (`fetch` globale incluso). Niente `npm install` da attendere in CI, niente supply chain da sorvegliare. La CI gira su Node 24 (LTS attiva); Node 20 è fuori supporto dal 30 aprile 2026 e non riceve più patch di sicurezza.

---

## 🚀 Setup passo-passo

### 1. Crea il repository privato

```bash
gh repo create looking-for-flights --private --source=. --remote=origin --push
```

Oppure da web: **New repository** → privato → poi `git remote add origin ... && git push -u origin main`.

### 2. Ottieni una chiave SerpApi

1. Registrati su **[serpapi.com](https://serpapi.com/users/sign_up)** (piano free: 100 ricerche/mese).
2. Copia la chiave da **[serpapi.com/manage-api-key](https://serpapi.com/manage-api-key)**.

> ⚠️ La quota API è la risorsa scarsa di questo progetto: 15 ricerche a run significano ~16 run al mese con un piano da 250. Leggi [Consumo della quota API](#-consumo-della-quota-api-leggimi) prima di alzare la frequenza del cron.

### 3. Crea il bot Telegram

**a) Crea il bot**

1. Apri Telegram e scrivi a **[@BotFather](https://t.me/BotFather)**.
2. Invia `/newbot`.
3. Scegli un nome (es. `Flight Watcher`) e uno username che finisca per `bot` (es. `giulio_flight_watcher_bot`).
4. BotFather ti restituisce il token, nel formato `123456789:AAF...`. **Questo è `TELEGRAM_BOT_TOKEN`.**

**b) Ricava il chat id**

Il bot non può scriverti finché non gli parli tu per primo.

1. Cerca il tuo bot su Telegram e premi **Start** (o invia un messaggio qualsiasi).
2. Scrivi a **[@userinfobot](https://t.me/userinfobot)**: ti risponde con il tuo `Id` numerico. **Questo è `TELEGRAM_CHAT_ID`.**

<details>
<summary>Metodo alternativo (senza bot di terze parti)</summary>

Dopo aver scritto al tuo bot, apri nel browser:

```
https://api.telegram.org/bot<IL_TUO_TOKEN>/getUpdates
```

Cerca `"chat":{"id":123456789,...}` nella risposta JSON.
</details>

<details>
<summary>Inviare a un gruppo invece che in privato</summary>

1. Aggiungi il bot al gruppo.
2. Invia un messaggio nel gruppo.
3. Apri `https://api.telegram.org/bot<TOKEN>/getUpdates` e prendi l'`id` del gruppo — **è negativo** (es. `-1001234567890`).
</details>

**c) Verifica subito che funzioni**

```bash
curl "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=test"
```

Se ricevi il messaggio, le due credenziali sono corrette.

### 4. (Opzionale) Webhook Slack

Se preferisci Slack, o vuoi entrambi i canali:

1. **[api.slack.com/apps](https://api.slack.com/apps)** → **Create New App** → *From scratch*.
2. **Incoming Webhooks** → attiva → **Add New Webhook to Workspace** → scegli il canale.
3. Copia l'URL `https://hooks.slack.com/services/...`. **Questo è `SLACK_WEBHOOK_URL`.**

I canali sono indipendenti: se uno fallisce, l'altro viene comunque tentato. Se non configuri nessun canale, il monitor gira lo stesso e i risultati restano nei log e nel job summary.

### 5. Configura le GitHub Secrets

**Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret | Obbligatorio | Descrizione |
|---|---|---|
| `BUDGET_ASIA_AUTUNNO_2026` | ✅ | Il tuo budget reale — vedi [Budget: privato anche a repo pubblico](#budget-privato-anche-a-repo-pubblico) |
| `SERPAPI_KEY` | ✅ (con provider serpapi) | Chiave SerpApi |
| `TELEGRAM_BOT_TOKEN` | ⬜ | Token da @BotFather |
| `TELEGRAM_CHAT_ID` | ⬜ | Il tuo id numerico |
| `SLACK_WEBHOOK_URL` | ⬜ | URL dell'Incoming Webhook |
| `AMADEUS_CLIENT_ID` | ⬜ | Solo con provider amadeus |
| `AMADEUS_CLIENT_SECRET` | ⬜ | Solo con provider amadeus |

Facoltativo, in **Variables** (non Secrets): `AMADEUS_ENV` = `test` | `production`.

### 6. Permessi di scrittura per la Action

**Settings** → **Actions** → **General** → **Workflow permissions** → seleziona **Read and write permissions** → **Save**.

Serve a `git-auto-commit-action` per committare lo snapshot aggiornato. Il workflow dichiara già `permissions: contents: write`, ma su alcuni account l'impostazione a livello di repo ha la precedenza.

### 7. Primo run manuale

**Actions** → **Flight Price Monitor** → **Run workflow**.

Puoi spuntare `force_notify` per farti mandare la notifica anche se nulla è cambiato, o `dry_run` per una prova a vuoto che non scrive né notifica.

---

## 💻 Esecuzione locale

```bash
# Prova completa senza API key, senza rete, senza consumare quota
npm run mock

# Anteprima del messaggio di notifica
npm run notify-test

# Run reale in sola lettura (usa l'API ma non scrive né notifica)
node --env-file=.env src/index.js --dry-run

# Run reale completo
node --env-file=.env src/index.js
```

Copia prima `.env.example` in `.env` e riempi i valori.

### Flag CLI

| Flag | Effetto |
|---|---|
| `--dry-run` | Non scrive lo stato, non invia notifiche, stampa l'anteprima del messaggio |
| `--force-notify` | Invia la notifica anche senza variazioni |
| `--provider=<nome>` | `serpapi` \| `amadeus` \| `mock` |
| `--config=<path>` | File di configurazione alternativo |
| `--state=<path>` | File di stato alternativo |
| `--trip=<id>` | Esegue un solo viaggio dalla config |
| `--budget=<numero>` | Solo per test locali: forza il budget senza passare dalla env var (usato da `npm run mock`/`notify-test`) |

---

## Ricerca su richiesta: comando /cerca su Telegram

Oltre al cron di mattina e sera (07:00 e 17:00 UTC), puoi far partire una ricerca quando vuoi tu, in due modi.

### Da GitHub (già pronto, nessun setup)

**Actions** → **Flight Price Monitor** → **Run workflow**. Nessuna configurazione aggiuntiva. Funziona anche dall'app GitHub su telefono.

### Scrivendo `/cerca` al bot Telegram (istantaneo)

```
Scrivi /cerca al bot
        │
        ▼
Telegram avvisa all'istante un piccolo webhook (Cloudflare Worker)
        │
        ├─ "/cerca" o "/check" ──▶ 🔍 ack immediato
        │                          + workflow_dispatch su GitHub (npm start)
        │                          + notifica col risultato, sempre
        ├─ "/start" o "/help"  ──▶ 📖 istruzioni, nessuna ricerca
        ├─ altro slash-command ──▶ ❓ "non lo conosco" + lista comandi
        └─ testo libero        ──▶ ignorato in silenzio
```

Il bot normalmente **manda** messaggi ma non li **riceve**: fargli ascoltare `/cerca` richiede qualcosa che sappia che hai scritto qualcosa. La prima versione lo faceva controllando Telegram ogni 15 minuti da GitHub Actions — misurato su una giornata reale, gli intervalli effettivi arrivavano a 26-42 minuti (GitHub accoda gli scheduled workflow e li dirada, vedi [history.md](history.md)). Ora invece Telegram avvisa **all'istante** un piccolo Cloudflare Worker, che fa partire subito la ricerca su GitHub: nessuna attesa strutturale.

Scrivi `/cerca` (o `/check`) nella chat con il bot: ricevi l'ack ("🔍 Ricerca avviata...") in pochi secondi, poi il risultato vero entro qualche minuto — il tempo della ricerca stessa, non dell'attesa.

**Setup richiesto** (una tantum, ~10 minuti): il webhook è l'unico pezzo del progetto che vive fuori da GitHub. Guida completa in [cloudflare-worker/README.md](cloudflare-worker/README.md). Senza quel setup, `/cerca` scritto in chat non fa nulla — resta comunque il pulsante "Run workflow" su GitHub.

### Comandi del bot

| Comando | Cosa fa |
| --- | --- |
| `/cerca` | Lancia subito una ricerca (alias: `/check`) |
| `/help` | Ricorda come funziona il bot e quali comandi esistono (alias: `/start`) |

Il testo libero non riceve risposta: la chat resta usabile anche per appunti. Uno slash-command inesistente invece una risposta la riceve — un bot che tace sembra rotto.

**Menu "/" nella chat**: la lista comandi va pubblicata su Telegram una volta sola con [`setMyCommands`](https://core.telegram.org/bots/api#setmycommands), altrimenti i comandi funzionano ma non compaiono nel menu a tendina.

- **Da GitHub** (consigliato, il token è già lì come secret): **Actions** → **Telegram Bot Admin** → **Run workflow**.
- **In locale**, se hai il token a portata di mano: `TELEGRAM_BOT_TOKEN=... npm run telegram:commands`.

Va rifatto solo quando cambia la lista in [src/telegram-commands.js](src/telegram-commands.js) — il menu è uno stato che vive su Telegram, non nel repo. In alternativa si può fare a mano da [@BotFather](https://t.me/BotFather) con `/setcommands`.

Nessuna secret nuova lato GitHub: il Worker riusa `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, ma li configura **una seconda volta**, come secret di Cloudflare — vive fuori da GitHub, non li eredita. Solo i messaggi dalla chat autorizzata vengono considerati.

---

## ⚙️ Riferimento configurazione

### Via rapida: cambiare le mete

Per aggiungere, togliere o ritoccare una destinazione non serve aprire il JSON. Modifica [config/mete.txt](config/mete.txt) — una riga per meta:

```
Nome della meta | HUB | spesa€/giorno | extra€ fissi

India (Rajasthan)             | DEL | 20 | 0
Thailandia (Isole del Golfo)  | BKK | 30 | 55
# Sri Lanka                   | CMB | 25 | 40      ← commentata = sospesa
```

poi:

```bash
npm run mete          # applica le modifiche a config/trips.json
npm run mete:check    # verifica l'allineamento senza scrivere (utile in CI)
```

Lo script dice esattamente cosa cambia, stima le ricerche API per run e avvisa se sfori `maxApiCallsPerRun`:

```
Modifiche:
   ~ modificata India del Nord (DEL): €/gg 20 → 24, extra 0 → 15
   + aggiunta   Sri Lanka (CMB)
   - rimossa    Malesia Peninsulare (KUL)
📊 Ricerche stimate per run: ~60 (5 mete × ~6 date × 2 durate)
```

> L'identità di una meta è il **codice HUB**: puoi rinominarla o cambiarne i costi senza perdere lo storico dei prezzi. Cambiare l'HUB invece equivale a crearne una nuova.

### Budget: privato anche a repo pubblico

`config/trips.json` è pensato per essere pubblico: destinazioni, aeroporti, date e costi giornalieri sono informazioni di viaggio, non dati sensibili. Il **budget totale no** — è l'unico numero personale, quindi non vive nel file versionato: viene letto a runtime da una variabile d'ambiente.

Convenzione del nome: `BUDGET_<ID-VIAGGIO-IN-MAIUSCOLO>` (i trattini diventano underscore). Per il viaggio di esempio, id `asia-autunno-2026`:

```bash
BUDGET_ASIA_AUTUNNO_2026=2000   # esempio — usa il tuo importo reale
```

- **In CI**: GitHub **Secret** con questo nome (vedi [Configura le GitHub Secrets](#5-configura-le-github-secrets)). Il workflow accetta anche una **Variable** con lo stesso nome (`secrets.X || vars.X`): creare il valore nella tab sbagliata di *Secrets and variables* è l'errore più comune, e non deve costare un pomeriggio di debug. Su repo pubblico però una variable è leggibile da chiunque — lì usa la secret.
- **In locale**: riga in `.env` (vedi [.env.example](.env.example)), caricata con `node --env-file=.env src/index.js`.
- **Senza budget** il monitor non si ferma più: cerca comunque i voli e produce una classifica **per solo prezzo**, dichiarandolo in cima alla notifica. Si perdono i giorni sostenibili e il costo totale, non la ricerca — che è l'80% del valore di un `/cerca`.
- **Con un valore malformato** (`1500 EUR`, `€1500`) il run invece fallisce, e deve: quello è un refuso, non una scelta, e proseguire con un numero a caso sarebbe peggio.

> ⚠️ Attenzione a come GitHub Actions passa le secret: una secret **inesistente** arriva al processo come **stringa vuota**, non come variabile assente. Il codice tratta quindi `""` come "non fornito" (→ modalità senza budget) e non come "valore non valido": è esattamente la distinzione che, quando mancava, faceva morire ogni run con un messaggio fuorviante.

Se aggiungi un secondo viaggio in `trips`, aggiungi la sua variabile con lo stesso schema (`BUDGET_<SUO-ID>`) sia in CI sia in locale.

Per lo stesso motivo, notifica, log e job summary **non mostrano mai**:
- il budget stesso;
- i "giorni teorici" (`maxDaysBudget`, il valore non tagliato a 21) — combinato con la spesa/giorno e il prezzo del volo, entrambi pubblici, permetterebbe di ricalcolare il budget esatto;
- il margine residuo (`avanzano X €`) — stesso motivo, combinato col costo totale mostrato.

Restano visibili giorni sostenibili (già tagliati a 21), prezzo del volo e costo totale del viaggio: sono l'informazione utile, senza rivelare quanto avevi messo da parte.

`npm run mock` e `npm run notify-test` funzionano senza impostare nulla: usano `--budget=1000`, un valore di comodo passato da riga di comando solo per i test (mai committato come parte della config reale).

### Configurazione completa

[config/trips.json](config/trips.json) contiene `defaults` (validi per tutti i viaggi) e un array `trips`.

```jsonc
{
  "defaults": {
    "provider": "serpapi",           // provider di default
    "currency": "EUR",
    "adults": 1,
    "notify": {
      "priceDropThreshold": 15,      // soglia calo prezzo in valuta
      "channels": ["telegram", "slack"]
    }
  },
  "trips": [
    {
      "id": "asia-autunno-2026",     // chiave usata nello snapshot: non cambiarla a cuor leggero
      "name": "Asia Autunno 2026",
      "enabled": true,               // false = saltato senza rimuoverlo
      // "budgetTotal" NON va qui — è privato, vedi la sezione sopra.
      // Letto a runtime dalla env var BUDGET_ASIA_AUTUNNO_2026.
      "currency": "EUR",
      "adults": 1,

      "departureWindow": {
        "from": "2026-09-01",
        "to":   "2026-10-31"
      },

      "tripDuration": {
        "min": 14,                   // durata minima accettabile
        "max": 21,                   // durata massima accettabile
        "standard": 21               // durata usata per la colonna "totale"
      },

      "origins": ["MXP", "BGY", "TRN"],   // codici IATA di partenza

      // Dettaglio per aeroporto nella notifica — vedi sotto
      "originGroups": [
        { "id": "torino", "label": "Torino", "airports": ["TRN"] },
        { "id": "milano", "label": "Milano", "airports": ["MXP", "BGY"] }
      ],

      "sampling": {
        "departureStrideDays": 14,   // ogni quanti giorni campionare la finestra
        "durationsToTest": [14, 21], // quali durate provare (devono stare in min..max)
        "maxApiCallsPerRun": 60,     // tetto di sicurezza sulle ricerche per run
        "concurrency": 3             // destinazioni in parallelo
      },

      "notify": { "priceDropThreshold": 15 },

      "candidates": [
        {
          "id": "india-rajasthan",
          "name": "India (Rajasthan)",
          "hub": "DEL",              // aeroporto di arrivo
          "groundCostPerDay": 20,    // spesa giornaliera a terra
          "fixedExtra": 0,           // costi fissi una tantum (visti, traghetti, voli interni)
          "notes": "..."             // solo documentazione
        }
      ]
    }
  ]
}
```

### Scadenza sul rientro (`returnBy`)

```jsonc
"departureWindow": { "from": "2026-09-01", "to": "2026-10-31" },
"returnBy": "2026-11-05"
```

Vincolo **indipendente** dalla finestra di partenza: una partenza può essere dentro `departureWindow` e comunque inutilizzabile, perché la durata del viaggio la spinge oltre la data entro cui bisogna essere rientrati. Con durata 21 giorni e `returnBy` al 5 novembre, l'ultima partenza utile è il **15 ottobre** — il 31 ottobre rientrerebbe il 21 novembre.

Applicato in due punti, per due motivi diversi:

1. **Nel piano di ricerca**, prima di chiamare l'API: le combinazioni escluse non vengono nemmeno cercate, quindi non costano quota. È anche la ragione per cui alzare `returnBy` o accorciare le durate cambia il numero di ricerche per run.
2. **Sui risultati**, come `tripDuration`: il provider è libero di restituire un ritorno diverso da quello chiesto, e una data oltre la scadenza rende il viaggio inutilizzabile a prescindere dal prezzo.

Se nessuna combinazione sopravvive al filtro il run si ferma con un errore esplicito, invece di cercare a vuoto e riportare "nessun volo trovato" su tutte le mete.

### Prezzo per aeroporto di partenza (`originGroups`)

La classifica è decisa dal prezzo **più basso in assoluto**, che con Milano in lista è quasi sempre Malpensa o Orio. Il risultato è che chi parte da Torino non scopriva mai quanto costa *da casa sua*: il volo da TRN veniva cercato (è in `origins`) ma, se non vinceva, spariva dal messaggio.

`originGroups` risolve questo: ogni gruppo dichiarato compare **sempre** nella notifica, vincitore o no.

```
Partenze a confronto
Da      Volo   Diff.  Durata
Torino  432 €  —      15h 30m
Milano  447 €  +15    13h 23m
```

Il `+15` è il numero che serve davvero: è il prezzo dello scarto tra i due aeroporti, da confrontare con quanto costano treno e tempo per arrivare a Milano. Accanto c'è la durata, perché a volte lo scarto si paga due volte — più caro *e* più lungo.

**Non consuma ricerche extra.** Google Flights accetta `departure_id=MXP,BGY,TRN` in una sola chiamata e restituisce gli itinerari da tutti e tre: prima si teneva solo il più economico e si buttava il resto, ora la risposta viene raggruppata per aeroporto di partenza. Stesso identico consumo di quota. Con `amadeus` (che interroga un origine per volta) vale lo stesso, per costruzione.

Un gruppo può indicare `non tra i risultati`: Google Flights tronca la lista, quindi un aeroporto molto più caro del vincitore a volte non compare. Significa "fuori dai risultati restituiti", **non** "nessun volo disponibile".

Se ometti `originGroups`, ogni aeroporto di `origins` diventa un gruppo a sé.

### Formato della notifica

Il messaggio è fatto di **tabelle monospaziate**, non di elenchi puntati: sei righe per destinazione moltiplicate per cinque destinazioni costringono a rileggere ogni riga per capire di cosa parla, mentre gli stessi numeri incolonnati si confrontano con lo sguardo.

```
🏆 Classifica (per giorni, poi costo)
#  Destinazione       Volo   Giorni
1  India (Rajasthan)  432 €  21/21
2  Vietnam Sud + Ca…  547 €  14/21

🥇 India (Rajasthan) · Delhi
Volo A/R   432 €
Partenza   Torino 29/09 12:00
Arrivo     Delhi 30/09 03:30
Durata     15h 30m · 1 scalo
Scalo      Istanbul · 5h 04m · notturno
Compagnia  Turkish Airlines
Ritorno    20/10 · 21 giorni
Giorni     21/21 pieni
Totale     852 € · 21 gg
A terra    20 €/gg
```

Cose da sapere su questo formato:

- **I codici IATA italiani diventano città**: `TRN` → Torino, `BGY` → Bergamo Orio. Dove una città ha più scali il nome li distingue (Malpensa e Linate non sono intercambiabili). Un codice sconosciuto resta il codice — meglio tre lettere oneste di un nome inventato. La mappa è in [src/utils/airports.js](src/utils/airports.js).
- **Orari, durata e scali sono del solo viaggio di andata.** Con `type=1` Google Flights restituisce le opzioni di andata (il prezzo è comunque quello A/R completo); i dettagli del ritorno richiedono una seconda chiamata con `departure_token`, cioè il doppio della quota per un dato che non cambia quale volo conviene. Del ritorno si mostra quindi la data.
- **Ogni riga è opzionale**: un provider che non espone gli scali produce una tabella più corta, non una tabella piena di `n/d`.
- **Vincolo tecnico**: Telegram non ha un markup di tabella, quindi sono blocchi `<pre>` allineati a spazi. Un `<pre>` non va a capo — scorre in orizzontale — perciò ogni riga sta entro `MAX_TABLE_WIDTH` (46 caratteri). Quando un messaggio supera i 4096 caratteri di Telegram, `splitMessage` richiude e riapre i blocchi sui pezzi: un `<pre>` tagliato a metà non darebbe una tabella brutta, ma **nessuna notifica** (`can't parse entities`).

### Aggiungere un viaggio

Appendi un nuovo oggetto all'array `trips` con un `id` diverso. Ogni viaggio ha il proprio snapshot indipendente in `data/last_prices.json` e la propria notifica. Per disattivarne uno temporaneamente: `"enabled": false`.

---

## 📊 Consumo della quota API (leggimi)

Il numero di ricerche per run è:

```
ricerche = destinazioni × date_di_partenza_campionate × durate_testate
```

Con la config attuale: **4 destinazioni × 3 date × 1 durata = 12 ricerche per run**. Il cron gira **due volte a settimana** (lunedì e giovedì): al massimo 9 esecuzioni in una finestra di 30 giorni, cioè **108 ricerche**, più i comandi `/cerca` — ognuno dei quali consuma un run intero.

⚠️ `maxApiCallsPerRun` deve **coprire il totale**: se è più basso, le ultime mete in ordine di configurazione vengono saltate in silenzio per esaurimento del budget interno del run. `npm run mete` lo ricalcola e avvisa quando aggiungi una destinazione.

### Il tetto che serviva davvero

`maxApiCallsPerRun` limita **una** esecuzione, e da solo non ha mai impedito nulla: dieci `/cerca` in un pomeriggio sono dieci run legittimi. Serviva un tetto che attraversasse i run, ed è `defaults.apiQuota`:

```jsonc
"apiQuota": {
  "monthlySearches": 250,      // il tuo piano SerpApi
  "reserveForOnDemand": 100,   // quota che il cron NON può toccare
  "windowDays": 30
}
```

Due scelte di progetto dietro questi tre numeri:

- **Finestra mobile di 30 giorni, non mese solare.** SerpApi azzera il contatore all'anniversario dell'iscrizione, una data che il programma non conosce. La finestra mobile evita di doverla sapere: è un po' conservativa a cavallo del rinnovo, e sbaglia quindi sempre dalla parte giusta — bloccare un run in più è recuperabile, sforare la quota no.
- **Il cron e `/cerca` non valgono uguale.** Il cron può saltare un giro senza che nessuno se ne accorga; un `/cerca` è una persona che sta aspettando. Le esecuzioni programmate si fermano quindi a `monthlySearches − reserveForOnDemand`, lasciando la riserva alle sole richieste esplicite. La distinzione arriva da `RUN_MODE`, che il workflow deriva dal tipo di evento.
- **La riserva va tarata sui conti, non a occhio.** Con 12 ricerche/run e 9 esecuzioni programmate per finestra servono 108 ricerche, coperte dal tetto `250 − 100 = 150`. Se la riserva fosse tanto alta da portare il tetto sotto il fabbisogno, l'ultimo run del mese verrebbe bloccato **di routine** invece che per eccezione — e un limite che scatta sempre non è un limite, è un guasto travestito. Le 100 di riserva valgono 8 `/cerca`.

Il consumo vive in `data/last_prices.json` sotto `quota`, un giorno per riga, potato oltre la finestra. Quando la quota è finita il run **non parte** — una ricerca che sappiamo verrà rifiutata è solo un modo più lento di fallire — e arriva un messaggio Telegram con la data in cui torna disponibile, invece del silenzio che si confonde con "nessuna variazione di prezzo".

### Come rientrare nella quota

| Leva | Effetto |
|---|---|
| `departureStrideDays: 30` | 6 date → 3 date, **−50%** |
| `durationsToTest: [21]` | 2 durate → 1, **−50%** |
| Cron settimanale (`0 7 * * 1`) invece di 2×/settimana | **−50%** sul mese |
| Alzare `reserveForOnDemand` | sposta quota dal cron a `/cerca`, a parità di totale |
| Meno `candidates` | proporzionale |

`/cerca` da Telegram consuma le stesse ricerche di un run schedulato: se lo usi spesso, tienine conto nel budget di quota.

**Config free-tier friendly** — 3 destinazioni × 3 date × 1 durata = 9 ricerche/run, settimanale ≈ 39/mese:

```jsonc
"sampling": {
  "departureStrideDays": 30,
  "durationsToTest": [21],
  "maxApiCallsPerRun": 12,
  "concurrency": 2
}
```

e nel workflow: `- cron: '0 7 * * 1'` (ogni lunedì).

> 💡 SerpApi accetta più aeroporti di partenza in una sola ricerca, quindi `MXP,BGY,TRN` costa **1** chiamata, non 3. Con Amadeus invece costa 3: il motore lo gestisce da solo tramite `supportsMultiOrigin`.

---

## 🔄 Cambiare provider

Il motore dipende solo dal contratto in [src/api/flightProvider.js](src/api/flightProvider.js), mai da un SDK specifico.

**Per passare ad Amadeus:**

1. Registrati su **[developers.amadeus.com](https://developers.amadeus.com/register)** e crea un'app → ottieni *API Key* e *API Secret*.
2. Aggiungi le secrets `AMADEUS_CLIENT_ID` e `AMADEUS_CLIENT_SECRET`.
3. In `config/trips.json`: `"provider": "amadeus"`. Oppure lancia il workflow manualmente scegliendo `amadeus` dal menu.

> L'ambiente `test` di Amadeus restituisce un inventario ridotto e in cache: utile per sviluppare, poco affidabile per i prezzi reali. Passa a `AMADEUS_ENV=production` quando hai le credenziali di produzione.

**Per aggiungere un provider nuovo:**

1. Crea `src/api/tuoProvider.js` che esporta `createProvider(env)` e una classe che estende `FlightProvider` implementando `searchRoundTrip(request) → FlightQuote | null`.
2. Registralo nella mappa `PROVIDERS` in `flightProvider.js`.

Nessuna modifica a `engine.js` o `index.js`.

---

## 🔧 Troubleshooting

| Sintomo | Causa e rimedio |
|---|---|
| `SERPAPI_KEY mancante` | Secret non impostata, o nome diverso. Controlla **Settings → Secrets → Actions**. |
| `quota esaurita` | Ricerche SerpApi finite. Vedi [Consumo della quota API](#-consumo-della-quota-api-leggimi). |
| Nessuna notifica ricevuta | Hai premuto **Start** sul bot? Le notifiche partono solo con variazioni rilevanti: prova `force_notify`. |
| `chat not found` | `TELEGRAM_CHAT_ID` errato, oppure non hai mai scritto al bot. |
| Arriva l'ack "🔍 Ricerca avviata" ma nessun risultato | Il run è fallito dopo l'ack. Il bot ti manda ora la riga di errore vera con il link ai log, quindi parti da lì. |
| Notifica con "⚠️ Budget non impostato" | La secret/variable `BUDGET_<TRIP_ID>` non esiste. La ricerca funziona lo stesso ma senza giorni sostenibili: creala per riavere la classifica completa. |
| Il bot non risponde a `/cerca` | Il webhook Cloudflare non è configurato o non è raggiungibile. Diagnosi ed esiti in [cloudflare-worker/README.md](cloudflare-worker/README.md#7-verifica) (`getWebhookInfo`). Nel frattempo: **Actions → Flight Price Monitor → Run workflow**. |
| Il menu "/" non compare nella chat | Comandi mai pubblicati su Telegram: **Actions → Telegram Bot Admin → Run workflow**, poi riapri la chat. |
| `Conflict: can't use getUpdates while webhook is active` | Il webhook Cloudflare è attivo (di proposito, se l'hai configurato) — `getUpdates` non funziona finché resta impostato. Per tornare al solo pulsante GitHub: `curl -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"`. |
| `nessun volo trovato` su tutte le rotte | Date troppo lontane (le compagnie pubblicano ~11 mesi prima) o codici IATA errati. |
| Il commit automatico non parte | **Settings → Actions → General → Workflow permissions** su *Read and write*. |
| Il cron non scatta | GitHub disattiva gli scheduled workflow dopo 60 giorni di inattività del repo. Riattivalo dalla tab Actions. |
| Il cron parte in ritardo | Normale: i runner condivisi possono accodare gli scheduled job di 10-30 minuti. |

Per log dettagliati con stack trace: `DEBUG=1 node src/index.js`.

### Codici di uscita

- `0` — tutto ok
- `1` — errore di configurazione, quota esaurita, o notifica fallita

Il workflow committa comunque i dati raccolti prima di segnalare il fallimento, così un errore parziale non fa perdere lo snapshot.

---

## 📄 Licenza

MIT
