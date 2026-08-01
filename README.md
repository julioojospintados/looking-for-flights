# ✈️ Looking for Flights

Monitoraggio automatico dei prezzi dei voli con **classifica per giorni di viaggio sostenibili a budget fisso**.

Due volte al giorno (mattina e sera) una GitHub Action cerca il volo A/R più economico verso ogni destinazione candidata, calcola quanti giorni potresti restare a terra con il budget residuo, ordina le destinazioni e ti scrive su Telegram **solo quando c'è davvero qualcosa da sapere** — oppure scrivi `/cerca` al bot per farla partire quando vuoi tu.

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
  - [Prezzo per aeroporto di partenza (originGroups)](#prezzo-per-aeroporto-di-partenza-origingroups)
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

### Il ciclo giornaliero

```
07:00 e 17:00 UTC ──▶ GitHub Action
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
│   ├── monitor.yml                 # Cron giornaliero + trigger manuale
│   └── telegram-poll.yml           # Ascolta /cerca su Telegram ogni 15 minuti
├── config/
│   ├── trips.json                  # ⭐ L'unico file da modificare per un nuovo viaggio
│   └── mete.txt                    # Via rapida per aggiungere/togliere destinazioni
├── data/
│   ├── last_prices.json            # Stato prezzi (committato dalla Action)
│   └── telegram_offset.json        # Ultimo comando Telegram già letto
├── scripts/
│   ├── sync-mete.js                # Applica config/mete.txt a config/trips.json
│   └── register-telegram-commands.js  # Pubblica il menu "/" del bot (setMyCommands)
├── src/
│   ├── api/
│   │   ├── flightProvider.js       # Contratto generico + factory + HTTP con retry
│   │   ├── serpapi.js              # Implementazione SerpApi (Google Flights)
│   │   ├── amadeus.js              # Implementazione Amadeus Self-Service
│   │   └── mock.js                 # Provider offline per test (nessuna quota consumata)
│   ├── utils/notifier.js           # Telegram + Slack
│   ├── engine.js                   # Piano di ricerca, budget, classifica
│   ├── index.js                    # Entry point: stato, delta, rendering, notifica
│   ├── telegram-commands.js        # Tabella comandi del bot (unica fonte di verità)
│   └── telegram-poll.js            # Ascolto comandi Telegram (getUpdates)
├── .env.example
└── package.json                    # Zero dipendenze runtime
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

> ⚠️ Con 100 ricerche/mese **non puoi girare ogni giorno** con la config di default. Leggi [Consumo della quota API](#-consumo-della-quota-api-leggimi) prima di attivare il cron.

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

### Da GitHub (istantaneo, già pronto)

**Actions** → **Flight Price Monitor** → **Run workflow**. Nessuna configurazione aggiuntiva: è lo stesso pulsante usato per il primo test. Funziona anche dall'app GitHub su telefono.

### Scrivendo `/cerca` al bot Telegram

Il bot normalmente **manda** messaggi ma non li **riceve**: per fargli ascoltare un comando serve qualcosa che controlli periodicamente se hai scritto qualcosa. Questo progetto lo fa con un secondo workflow, [.github/workflows/telegram-poll.yml](.github/workflows/telegram-poll.yml):

```
ogni 15 minuti ──▶ GitHub controlla i messaggi nuovi del bot (getUpdates)
                      │
                      ├─ "/cerca" o "/check" ──▶ 🔍 ack immediato
                      │                           + ricerca vera (npm start)
                      │                           + notifica col risultato
                      ├─ "/start" o "/help"  ──▶ 📖 istruzioni, nessuna ricerca
                      ├─ altro slash-command ──▶ ❓ "non lo conosco" + lista comandi
                      └─ testo libero        ──▶ ignorato in silenzio
```

Scrivi `/cerca` (o `/check`) nella chat con il bot: ricevi prima un ack ("🔍 Ricerca avviata..."), poi il risultato vero e proprio — **sempre**, anche se i prezzi non sono cambiati, perché un comando esplicito merita sempre una risposta.

⏱ **Quanto aspettare, davvero.** Il cron è `*/15`, ma GitHub accoda gli scheduled workflow sui runner condivisi e li dirada tanto più quanto sono frequenti: misurato su una giornata reale, gli intervalli effettivi stanno tra i 26 e i 42 minuti. Se l'ack non è ancora arrivato il comando è **in coda, non perso**. Per una risposta immediata: Actions → *Telegram On-Demand Search* → **Run workflow**, che esegue subito lo stesso identico job.

### Comandi del bot

| Comando | Cosa fa |
| --- | --- |
| `/cerca` | Lancia subito una ricerca (alias: `/check`) |
| `/help` | Ricorda come funziona il bot e quali comandi esistono (alias: `/start`) |

Il testo libero non riceve risposta: la chat resta usabile anche per appunti. Uno slash-command inesistente invece una risposta la riceve — un bot che tace sembra rotto.

**Menu "/" nella chat**: la lista comandi va pubblicata su Telegram una volta sola con [`setMyCommands`](https://core.telegram.org/bots/api#setmycommands), altrimenti i comandi funzionano ma non compaiono nel menu a tendina. Due modi:

- **Da GitHub** (consigliato, il token è già lì come secret): **Actions** → **Telegram On-Demand Search** → **Run workflow**, spuntando `register_commands`.
- **In locale**, se hai il token a portata di mano: `TELEGRAM_BOT_TOKEN=... npm run telegram:commands`.

Va rifatto solo quando cambia la lista in [src/telegram-commands.js](src/telegram-commands.js) — il menu è uno stato che vive su Telegram, non nel repo, quindi non è un passo del cron. In alternativa si può fare a mano da [@BotFather](https://t.me/BotFather) con `/setcommands`.

Nessuna secret nuova: riusa `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` già configurate. Solo i messaggi dalla chat autorizzata (`TELEGRAM_CHAT_ID`) vengono considerati.

**Stato**: `data/telegram_offset.json` tiene traccia dell'ultimo messaggio già letto, così lo stesso comando non fa mai partire due ricerche. È committato in git dallo stesso meccanismo di `data/last_prices.json` — non contiene nulla di sensibile (solo un numero incrementale di Telegram).

**Perché non è "zero controlli finché non scrivo /cerca"**: senza qualcosa che controlli a intervalli, non c'è modo che GitHub si accorga del messaggio — le Actions non restano in ascolto 24/7 di loro iniziativa. Uno "zero" vero richiederebbe un piccolo servizio esterno sempre attivo come webhook Telegram (es. Cloudflare Worker), fuori da GitHub: la strada scartata all'inizio per restare senza dipendenze esterne. Il controllo stesso è comunque leggero — una chiamata `getUpdates`, non una ricerca voli — e non consuma quota SerpApi.

> ⚠️ **Costo in minuti Actions**: il polling gira ~96 volte al giorno (ogni run dura pochi secondi). Su repository **pubblico** i minuti sono illimitati sui runner standard. Su repository **privato** rientrano nel piano gratuito solo se non è già saturato da altro — vedi la nota in `todo.md` se il repo non è ancora pubblico.

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

- **In CI**: GitHub Secret con questo nome (vedi [Configura le GitHub Secrets](#5-configura-le-github-secrets)).
- **In locale**: riga in `.env` (vedi [.env.example](.env.example)), caricata con `node --env-file=.env src/index.js`.
- **Senza questa variabile**, il monitor si ferma subito con un errore che indica esattamente quale impostare — non parte con un budget a caso.

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

### Prezzo per aeroporto di partenza (`originGroups`)

La classifica è decisa dal prezzo **più basso in assoluto**, che con Milano in lista è quasi sempre Malpensa o Orio. Il risultato è che chi parte da Torino non scopriva mai quanto costa *da casa sua*: il volo da TRN veniva cercato (è in `origins`) ma, se non vinceva, spariva dal messaggio.

`originGroups` risolve questo: ogni gruppo dichiarato compare **sempre** nella notifica, vincitore o no.

```
🥇 India (Rajasthan) (DEL)
   🛬 Volo A/R: 432 EUR da TRN | 2026-09-29 → 2026-10-20
   📅 21/21 gg pieni | 💸 20 EUR/gg
   🧮 Totale 21 gg: 852 EUR
   🛫 Torino (TRN): 432 EUR · ✅ il migliore · 2026-09-29 → 2026-10-20
   🛫 Milano (MXP): 447 EUR · +15 EUR · 2026-09-01 → 2026-09-15
```

Il `+15 EUR` è il numero che serve davvero: è il prezzo dello scarto tra i due aeroporti, da confrontare con quanto costano treno e tempo per arrivare a Milano.

**Non consuma ricerche extra.** Google Flights accetta `departure_id=MXP,BGY,TRN` in una sola chiamata e restituisce gli itinerari da tutti e tre: prima si teneva solo il più economico e si buttava il resto, ora la risposta viene raggruppata per aeroporto di partenza. Stesso identico consumo di quota. Con `amadeus` (che interroga un origine per volta) vale lo stesso, per costruzione.

Un gruppo può indicare `non tra i risultati`: Google Flights tronca la lista, quindi un aeroporto molto più caro del vincitore a volte non compare. Significa "fuori dai risultati restituiti", **non** "nessun volo disponibile".

Se ometti `originGroups`, ogni aeroporto di `origins` diventa un gruppo a sé.

### Aggiungere un viaggio

Appendi un nuovo oggetto all'array `trips` con un `id` diverso. Ogni viaggio ha il proprio snapshot indipendente in `data/last_prices.json` e la propria notifica. Per disattivarne uno temporaneamente: `"enabled": false`.

---

## 📊 Consumo della quota API (leggimi)

Il numero di ricerche per run è:

```
ricerche = destinazioni × date_di_partenza_campionate × durate_testate
```

Con la config di default: **5 destinazioni × 6 date × 2 durate = 60 ricerche per run**. Il cron gira **due volte al giorno** (mattina e sera): **~3600 ricerche al mese**, più eventuali comandi `/cerca` (ognuno consuma un run intero). Il piano free di SerpApi ne offre 100 al mese.

`maxApiCallsPerRun` è un tetto di sicurezza: superata la soglia, il run si ferma e le destinazioni non ancora processate vengono segnalate invece di consumare quota a sorpresa.

### Come rientrare nella quota

| Leva | Effetto |
|---|---|
| `departureStrideDays: 30` | 6 date → 3 date, **−50%** |
| `durationsToTest: [21]` | 2 durate → 1, **−50%** |
| Un solo run/giorno invece di due | rimuovi una delle due righe `cron:` in `monitor.yml`, **−50%** |
| Cron settimanale (`0 7 * * 1`) | **−85%** sul mese |
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
| Arriva l'ack "🔍 Ricerca avviata" ma nessun risultato | Il run è fallito dopo l'ack. Causa più frequente: la secret `BUDGET_<TRIP_ID>` non esiste o è vuota, e il monitor si rifiuta di partire senza budget. Da oggi il bot ti manda un messaggio di errore col link ai log invece di restare zitto. |
| Il bot non risponde ai comandi | Quasi sempre è solo attesa: gli intervalli reali del poll sono 26-42 minuti, non 15. Verifica l'orario dell'ultimo run di **Telegram On-Demand Search** nella tab Actions: se è precedente al tuo messaggio, il comando è in coda. Per forzare: **Run workflow**. |
| Il menu "/" non compare nella chat | Comandi mai pubblicati su Telegram: lancia **Run workflow** con `register_commands`, poi riapri la chat. |
| `Conflict: can't use getUpdates while webhook is active` | Al bot è stato assegnato un webhook (da un altro progetto o da un test). Rimuovilo: `curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"`. |
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
