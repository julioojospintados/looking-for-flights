# Storico delle modifiche

Cosa è cambiato, quando, e **perché** — la parte che il diff non racconta.
Il dettaglio tecnico sta nel README; qui restano le decisioni e i motivi.

Ordine cronologico inverso: le cose più recenti in alto.

---

## 2026-08-01 — "Ogni 15 minuti" non era vero

Un `/cerca` delle 17:55 sembrava ignorato: nessun ack dopo undici minuti.
Non era un guasto — il poller semplicemente non era ancora partito. Gli
intervalli reali misurati su una giornata:

```
11:12 → 11:43 (31 min) → 12:11 (28) → 12:37 (26) → 13:11 (34)
      → 13:52 (41) → 14:34 (42) → 15:09 (35) → 15:39 (30)   [UTC]
```

Il cron dice `*/15`, GitHub esegue ogni 26-42 minuti: accoda e dirada gli
scheduled workflow sui runner condivisi, tanto più quanto sono frequenti.
Abbassare l'intervallo non aiuta — verrebbe diradato di più.

Il difetto era nella promessa, non nel codice: il messaggio di `/help` diceva
"leggo i messaggi ogni 15 minuti circa", e quel numero trasformava un'attesa
normale nel sospetto di un guasto. Ora `/help` e README dichiarano 15-45
minuti, aggiungono che un ack mancante significa "in coda, non perso", e
indicano la scorciatoia per chi non vuole aspettare: Actions → Run workflow,
che esegue subito lo stesso job.

---

## 2026-08-01 — Node 24 e fine dei fallimenti silenziosi

### Il bot mandava l'ack e poi spariva

Sintomo: `/cerca` alle 15:50, ack "🔍 Ricerca avviata, risultati a breve..." alle
15:52, poi più niente. Nessun errore visibile da Telegram.

Causa, dai log del run fallito: la secret `BUDGET_ASIA_AUTUNNO_2026` **non
esiste**. Quando il budget è diventato privato (commit `ad901d4`) è uscito da
`config/trips.json`, ma non è mai stato creato il corrispondente GitHub Secret.
Il monitor si rifiuta di partire senza budget — cosa giusta — ed esce con
errore prima di poter notificare qualsiasi cosa.

```
BUDGET_ASIA_AUTUNNO_2026:
❌ Errore fatale: BUDGET_ASIA_AUTUNNO_2026: valore non valido (""), deve essere un numero > 0.
```

**Rimedio richiesto una volta sola**: Settings → Secrets and variables →
Actions → New repository secret, nome `BUDGET_ASIA_AUTUNNO_2026`.

### Un ack senza esito è peggio di nessun ack

Il difetto vero non era il secret mancante — quello è configurazione — ma il
fatto che il software avesse **promesso** un risultato e poi taciuto. L'unico
modo di accorgersene era aprire la tab Actions, cioè esattamente la cosa che
il bot Telegram esiste per evitare.

Entrambi i workflow ora chiudono con uno step che, in caso di fallimento,
scrive su Telegram con il link ai log del run. Lo step sta **in fondo** per
necessità: `failure()` diventa vero solo dopo che un passo è fallito, e il
passo che trasforma l'errore del monitor (`continue-on-error`) in fallimento
del job è proprio quello immediatamente precedente.

Il messaggio non riporta il testo dell'errore, solo il link: i dettagli stanno
nei log, e il canale Telegram non deve diventare un posto dove può finire per
sbaglio il contenuto di una variabile d'ambiente.

Vale anche per il cron: un run schedulato che fallisce è silenzioso per
definizione — nessuno guarda le Actions due volte al giorno. Senza avviso, una
quota finita si manifesta solo come notifiche che smettono di arrivare,
indistinguibile da "i prezzi non sono cambiati".

### Node 20 → 24

Node 20 è fuori supporto dal **30 aprile 2026**: niente più patch di sicurezza.
I runner GitHub lo segnalavano già a ogni esecuzione, forzando le action su
Node 24.

- CI su **Node 24** (LTS attiva fino ad aprile 2028).
- `engines: ">=22"` in `package.json`: 22 è ancora in manutenzione, quindi chi
  lavora in locale su 22 non viene bloccato senza motivo. La CI resta pinnata
  su 24 — l'ambiente riproducibile è quello, non la forchetta.
- Action aggiornate: `checkout@v7`, `setup-node@v7`,
  `git-auto-commit-action@v7`, tutte già su runtime Node 24.

Nessun cambiamento di codice: il progetto usa solo API stabili (`fetch`
globale, `node:fs/promises`), disponibili identiche da Node 18 in poi.

---

## 2026-08-01 — Prezzo da Torino sempre visibile

La classifica sceglie il prezzo **più basso in assoluto**, che con Milano in
lista è quasi sempre Malpensa o Orio. Risultato: il volo da Torino veniva
cercato (TRN è in `origins`), pagato in quota API, e poi scartato senza mai
comparire. Mancava proprio il numero che serve per decidere — **quanto costa
lo scarto**, da confrontare con treno e tempo per arrivare a Milano.

Ora ogni destinazione mostra sempre entrambi i gruppi:

```
🥇 India (Rajasthan) (DEL)
   🛬 Volo A/R: 432 EUR da TRN | 2026-09-29 → 2026-10-20
   🛫 Torino (TRN): 432 EUR · ✅ il migliore · 2026-09-29 → 2026-10-20
   🛫 Milano (MXP): 447 EUR · +15 EUR · 2026-09-01 → 2026-09-15
```

**Costo in quota: zero.** Google Flights accetta `departure_id=MXP,BGY,TRN` in
una chiamata sola e restituisce gli itinerari da tutti e tre gli aeroporti:
prima se ne teneva uno e si buttava il resto, ora la stessa risposta viene
raggruppata per aeroporto di partenza (`byOrigin` sul `FlightQuote`). Stesse 60
ricerche per run.

Decisioni degne di nota:

- **La classifica non cambia**: continua a ordinare per giorni sostenibili sul
  prezzo minimo. Il dettaglio per aeroporto è informativo, non decisionale —
  mescolare le due cose avrebbe reso il ranking impossibile da spiegare.
- **`non tra i risultati` non significa "non si vola"**. Google tronca la lista
  degli itinerari, quindi un aeroporto molto più caro a volte non compare.
  Distinguere i due casi evita di leggere un'assenza come un prezzo infinito.
- **Configurabile** via `originGroups`; senza configurazione, un gruppo per
  aeroporto. Un aeroporto in `origins` ma in nessun gruppo produce un warning
  invece di sparire in silenzio.
- Nello snapshot committato finiscono solo prezzo e rotta per gruppo: nessun
  dato derivato dal budget privato, stessa regola già applicata a
  `maxDaysBudget`.

---

## 2026-08-01 — Il bot risponde a `/start` e `/help`

Il poller riconosceva solo `/cerca` e `/check`; tutto il resto veniva letto,
l'offset avanzava, e finiva ignorato. Scrivendo `/start` — il primo comando che
chiunque manda a un bot Telegram — non succedeva nulla, e il bot sembrava
morto.

- `/start` e `/help` rispondono con le istruzioni, senza lanciare ricerche né
  consumare quota SerpApi.
- Uno slash-command inesistente riceve la lista di quelli veri. Il testo libero
  resta invece ignorato in silenzio: la chat deve restare usabile anche per
  appunti.
- Un refuso seguito dal comando corretto nello stesso lotto non produce il
  messaggio "non lo conosco": è rumore su un errore che hai già corretto.
- La tabella comandi vive in `src/telegram-commands.js`, condivisa tra il
  poller e lo script che pubblica il menu. Se fossero due liste separate, il
  menu potrebbe promettere comandi che il poller ignora.

**Menu "/" della chat**: si pubblica con `setMyCommands`, una volta sola, via
`npm run telegram:commands` oppure dalla tab Actions con l'input
`register_commands` (che evita di dover avere il token in locale). Non è un
passo del cron: il menu è uno stato che vive su Telegram, non nel repo, e
riscriverlo a ogni poll sarebbero ~96 chiamate al giorno per non cambiare
nulla.

---

## Prima di questo storico

Le modifiche precedenti sono documentate solo nella cronologia git. Punti
salienti:

- Budget reso privato: fuori da `config/trips.json`, letto a runtime da
  `BUDGET_<TRIP_ID>` — così la config resta pubblicabile.
- Run serale aggiunto al cron (07:00 e 17:00 UTC).
- Ricerca su richiesta via Telegram (`/cerca`), con polling ogni 15 minuti.
