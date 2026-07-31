# ✈️ Looking for Flights

Monitoraggio automatico dei prezzi dei voli con **classifica per giorni di viaggio sostenibili a budget fisso**.

Ogni giorno una GitHub Action cerca il volo A/R più economico verso ogni destinazione candidata, calcola quanti giorni potresti restare a terra con il budget residuo, ordina le destinazioni e ti scrive su Telegram **solo quando c'è davvero qualcosa da sapere**.

> **Architettura "Engine + Config"** — tutta la logica di dominio vive in [config/trips.json](config/trips.json). Per monitorare un viaggio completamente diverso (altre date, altro budget, altre destinazioni) non si tocca una riga di codice.

---

## 📑 Indice

- [Come funziona](#-come-funziona)
- [Struttura del progetto](#-struttura-del-progetto)
- [Setup passo-passo](#-setup-passo-passo)
- [Esecuzione locale](#-esecuzione-locale)
- [Riferimento configurazione](#-riferimento-configurazione)
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

Esempio con prezzi reali (31 lug 2026, budget 1500 €):

| Destinazione | Volo A/R | Spesa/gg | Extra | Giorni | Budget per | Totale 21 gg | Avanzano |
|---|---|---|---|---|---|---|---|
| 🥇 India (DEL) | 506,40 € | 20 € | 0 € | **21/21** | 49 gg | 926,40 € | 573,60 € |
| 🥈 Indonesia (CGK) | 468,80 € | 27 € | 70 € | **21/21** | 35 gg | 1105,80 € | 394,20 € |
| 🥉 Vietnam (SGN) | 502,95 € | 27 € | 60 € | **21/21** | 34 gg | 1129,95 € | 370,05 € |
| 4 Malesia (KUL) | 512,53 € | 33 € | 0 € | **21/21** | 29 gg | 1205,53 € | 294,47 € |
| 5 Thailandia (BKK) | 546,43 € | 30 € | 55 € | **21/21** | 29 gg | 1231,43 € | 268,57 € |

Il volo più economico è Giacarta, ma vince l'India perché costa 7 €/giorno in meno a terra: **la spesa giornaliera pesa più del volo**. Quando il budget non basta per i 21 giorni pieni, la notifica lo dice: `10/21 gg (budget insufficiente per 21)`.

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
07:00 UTC ──▶ GitHub Action
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
├── .github/workflows/monitor.yml   # Cron giornaliero + trigger manuale
├── config/trips.json               # ⭐ L'unico file da modificare per un nuovo viaggio
├── data/last_prices.json           # Stato persistente (committato dalla Action)
├── src/
│   ├── api/
│   │   ├── flightProvider.js       # Contratto generico + factory + HTTP con retry
│   │   ├── serpapi.js              # Implementazione SerpApi (Google Flights)
│   │   ├── amadeus.js              # Implementazione Amadeus Self-Service
│   │   └── mock.js                 # Provider offline per test (nessuna quota consumata)
│   ├── utils/notifier.js           # Telegram + Slack
│   ├── engine.js                   # Piano di ricerca, budget, classifica
│   └── index.js                    # Entry point: stato, delta, rendering, notifica
├── .env.example
└── package.json                    # Zero dipendenze runtime
```

**Zero dipendenze**: il progetto usa solo la standard library di Node 20+ (`fetch` globale incluso). Niente `npm install` da attendere in CI, niente supply chain da sorvegliare.

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
      "budgetTotal": 1500,           // budget complessivo, volo incluso
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

### Aggiungere un viaggio

Appendi un nuovo oggetto all'array `trips` con un `id` diverso. Ogni viaggio ha il proprio snapshot indipendente in `data/last_prices.json` e la propria notifica. Per disattivarne uno temporaneamente: `"enabled": false`.

---

## 📊 Consumo della quota API (leggimi)

Il numero di ricerche per run è:

```
ricerche = destinazioni × date_di_partenza_campionate × durate_testate
```

Con la config di default: **5 destinazioni × 6 date × 2 durate = 60 ricerche per run**, cioè **~1800 al mese** con il cron giornaliero. Il piano free di SerpApi ne offre 100 al mese.

`maxApiCallsPerRun` è un tetto di sicurezza: superata la soglia, il run si ferma e le destinazioni non ancora processate vengono segnalate invece di consumare quota a sorpresa.

### Come rientrare nella quota

| Leva | Effetto |
|---|---|
| `departureStrideDays: 30` | 6 date → 3 date, **−50%** |
| `durationsToTest: [21]` | 2 durate → 1, **−50%** |
| Cron settimanale (`0 7 * * 1`) | **−85%** sul mese |
| Meno `candidates` | proporzionale |

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
