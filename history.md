# Storico delle modifiche

Cosa è cambiato, quando, e **perché** — la parte che il diff non racconta.
Il dettaglio tecnico sta nel README; qui restano le decisioni e i motivi.

Ordine cronologico inverso: le cose più recenti in alto.

---

## 2026-08-02 — Scadenza sul rientro, e ricerca dimagrita

Tre cambi che si tengono insieme: un vincolo nuovo, due mete in meno, e il
costo per run che scende da 18 a 12 ricerche.

### `returnBy`: il ritorno entro il 5 novembre

Vincolo **indipendente** dalla finestra di partenza, e la distinzione non è
formale: una partenza può essere dentro `departureWindow` e comunque
inutilizzabile, perché la durata la spinge oltre la data entro cui bisogna
essere rientrati. Con 21 giorni e scadenza al 5 novembre, l'ultima partenza
utile è il **15 ottobre** — il 31 ottobre rientrerebbe il 21 novembre.

Si sarebbe potuto ottenere lo stesso effetto accorciando `departureWindow.to`
al 15 ottobre, ed è la scorciatoia sbagliata: quel numero dipende dalla durata
del viaggio, quindi andrebbe ricalcolato a mano ogni volta che cambia
`durationsToTest`, e sarebbe silenziosamente errato con più durate in gioco
(14 giorni permetterebbero partenze fino al 22 ottobre). La regola dichiara
l'intento e lascia fare il conto al programma.

Applicata in due punti, per due motivi diversi:

1. **Nel piano di ricerca**, prima di chiamare l'API: le combinazioni escluse
   non vengono cercate, quindi non costano quota. È anche il motivo per cui il
   costo per run dipende da `returnBy`.
2. **Sui risultati**, insieme al controllo su `tripDuration`: il provider è
   libero di restituire un ritorno diverso da quello chiesto, e una data oltre
   la scadenza rende il viaggio inutilizzabile a prescindere dal prezzo.

Se il filtro non lascia sopravvivere nulla il run si ferma con un errore
esplicito, invece di cercare a vuoto e riportare "nessun volo trovato" su
tutte le mete — un sintomo che manderebbe a cercare il guasto nel posto
sbagliato.

### Meno mete, meno ricerche

Rimossi Vietnam+Cambogia (SGN) e Malesia (KUL), commentati in `mete.txt`
invece che cancellati: l'identità di una meta è il codice HUB, quindi
riattivarle ritrova lo storico prezzi già raccolto.

Il conto per run: 4 mete × 3 date × 1 durata = **12 ricerche**, contro le 18
di prima e le 60 di ieri. Le tre date (01/09, 23/09, 15/10) coprono l'intera
finestra ancora utilizzabile: la quarta, il 31/10, è caduta con la scadenza
sul rientro.

Di conseguenza `reserveForOnDemand` torna a 100: 9 esecuzioni programmate per
finestra costano 108 ricerche, dentro il tetto `250 − 100 = 150`, e le 100 di
riserva valgono 8 `/cerca`.

> Nota: si testa solo la durata di 21 giorni. Aggiungere anche 14 in
> `durationsToTest` raddoppierebbe il costo per run — e permetterebbe partenze
> fino al 22 ottobre, che la durata di 3 settimane esclude.

---

## 2026-08-02 — Sri Lanka fra le mete

Aggiunta scommentando la riga già pronta in `config/mete.txt` (`CMB`, 25 €/gg,
40 € di extra) e sincronizzando con `npm run mete`: è il flusso previsto dal
progetto, e lo script ha fatto il suo mestiere avvisando che le 6 mete non
stavano più nel tetto di 15 ricerche per run.

Due numeri da rifare, entrambi conseguenza diretta della sesta meta:

- **`maxApiCallsPerRun` 15 → 18.** Il tetto deve coprire il totale
  (6 mete × 3 date × 1 durata): più basso, le ultime mete in ordine di
  configurazione verrebbero saltate **in silenzio** per esaurimento del
  budget interno del run — un dato mancante che sembra un volo non trovato.
- **`reserveForOnDemand` 100 → 85.** Con 18 ricerche a run, una finestra di
  30 giorni contiene al massimo 9 esecuzioni programmate = 162 ricerche. Una
  riserva di 100 lascerebbe al cron un tetto di 150, sotto il suo stesso
  fabbisogno: l'ultimo run del mese verrebbe bloccato **di routine** invece
  che per eccezione, e un limite che scatta sempre non è un limite, è un bug
  con l'aria di essere intenzionale. A 85, il tetto del cron è 165 e le 85
  rimaste valgono 4 `/cerca`.

---

## 2026-08-02 — 225 ricerche su 250 bruciate in due giorni

Email di SerpApi: *"You've used 90% of your searches"* — 225 su 250 del piano
mensile, consumate in due giorni. Ne restavano 25, e il cron del mattino
dopo ne avrebbe chieste 60.

Il conto dei run di quel giorno:

```
07:47 cron mattina    60      19:51 /cerca   60
17:22 cron sera       60      20:12 /cerca   60
                              21:04 /cerca   60
```

Tre cause sovrapposte, e la seconda è nostra:

1. **Il costo per run era 60** (5 mete × 6 date × 2 durate) e il cron girava
   **due volte al giorno**: 3600 ricerche al mese contro 250 disponibili. Era
   scritto nel README fin dall'inizio, e ignorato fin dall'inizio.
2. **La correzione del budget del giorno prima.** Finché ogni `/cerca` moriva
   sulla secret mancante, consumava **zero** ricerche: i fallimenti stavano
   involontariamente proteggendo la quota. Farli degradare invece che morire
   era giusto per chi usa il bot, ma ha tolto un freno di cui nessuno
   sospettava l'esistenza.
3. **Il webhook.** Con `/cerca` istantaneo è naturale lanciarlo tre volte in
   un'ora. Ogni volta, 60 ricerche.

### Il tetto che mancava

`maxApiCallsPerRun` limita **una** esecuzione, e da solo non ha mai impedito
niente: dieci `/cerca` sono dieci run legittimi da 60. Serviva un tetto che
attraversasse i run — `defaults.apiQuota`, in `src/utils/quota.js`.

Tre decisioni dentro quel modulo:

- **Finestra mobile di 30 giorni, non mese solare.** SerpApi azzera
  all'anniversario dell'iscrizione, data che il programma non conosce. La
  finestra mobile evita di doverla sapere ed è un po' conservativa a cavallo
  del rinnovo: sbaglia sempre dalla parte giusta, perché bloccare un run in
  più è recuperabile e sforare la quota no.
- **Il cron e `/cerca` non valgono uguale.** Il cron può saltare un giro senza
  che nessuno se ne accorga; un `/cerca` è una persona che sta aspettando. Le
  esecuzioni programmate si fermano a `monthlySearches − reserveForOnDemand`,
  e solo le richieste esplicite possono intaccare la riserva.
- **A quota esaurita il run non parte.** Una ricerca che sappiamo verrà
  rifiutata dall'API è solo un modo più lento di fallire. Arriva invece un
  messaggio Telegram con la data in cui la quota torna disponibile — perché un
  run che si ferma in silenzio è indistinguibile da "nessuna variazione di
  prezzo", lo stesso equivoco che rendeva invisibili i fallimenti.

### Il seme delle 225

Il contatore parte da uno stato vuoto, quindi al primo avvio avrebbe
autorizzato altre 250 ricerche già spese. `data/last_prices.json` è stato
inizializzato a mano con il consumo reale comunicato da SerpApi: senza quel
seme il tetto sarebbe stato corretto e inutile.

### Costo per run: 60 → 15

`departureStrideDays` 14 → 30 (6 date → 3) e `durationsToTest` [14,21] → [21].
Cron da due volte al giorno a **lunedì e giovedì**: ~130 ricerche al mese di
monitoraggio automatico, ~120 lasciate ai `/cerca`. Si perde la granularità
sulle date di partenza — che con un budget di 250 ricerche al mese non era
comunque sostenibile.

---

## 2026-08-01 — Notifica in tabella, con il volo per intero

La notifica diceva prezzo e date e si fermava lì. Ma "426 €" non basta per
decidere: un volo con 11 ore di scalo notturno a Muscat e uno diretto allo
stesso prezzo sono due viaggi diversi, e finora la differenza si scopriva solo
aprendo Google Flights.

Ora ogni destinazione riporta **compagnia, orario di partenza e di arrivo,
durata porta a porta, numero di scali e durata di ciascuno scalo** — inclusa
l'informazione se lo scalo scavalca la notte, che è la differenza fra
aspettare e dover dormire da qualche parte.

Costo in quota API: **zero**. Erano tutti dati già presenti nella stessa
risposta di Google Flights, semplicemente scartati durante il parsing.

Tre decisioni degne di nota:

- **Solo l'andata ha gli orari.** Con `type=1` Google Flights restituisce le
  opzioni di andata (il prezzo resta quello A/R completo); i dettagli del
  ritorno arrivano solo da una seconda chiamata con `departure_token`, cioè
  raddoppiando il consumo di quota per un dato che non cambia quale volo
  conviene. Del ritorno resta la data, ed è dichiarato invece che lasciato
  intendere.
- **Gli orari non passano mai da `new Date()`.** Sono orari *locali
  all'aeroporto* e senza fuso: interpretarli come date li sposterebbe di ore
  in CI, dove il runner è in UTC. Vengono riformattati come stringhe.
- **Ogni riga della tabella è opzionale.** Un provider che non espone gli
  scali produce una tabella più corta, non una tabella piena di `n/d`:
  mostrare il nulla in modo ordinato è peggio che non mostrarlo.

### Perché tabelle e non elenchi

Sei righe puntate per destinazione, per cinque destinazioni, obbligano a
rileggere ogni riga per capire di cosa parla. Gli stessi numeri incolonnati si
confrontano con lo sguardo — che è l'unica cosa che si fa davvero con una
notifica sul telefono.

Telegram non ha un markup di tabella: sono blocchi `<pre>` allineati a spazi.
Da lì due vincoli non ovvi:

1. **Un `<pre>` non va a capo, scorre in orizzontale.** Una riga troppo lunga
   non si rompe: si nasconde. Da qui `MAX_TABLE_WIDTH` a 46 caratteri e il
   troncamento dei nomi lunghi.
2. **Un `<pre>` tagliato a metà non dà una tabella brutta, dà *nessuna
   notifica*.** Telegram rifiuta l'intero messaggio con `can't parse entities`
   se il markup non è bilanciato, e i messaggi oltre i 4096 caratteri vengono
   spezzati. `splitMessage` ora richiude e riapre i blocchi sui pezzi.
   Il primo tentativo contava i tag aperti e chiusi per pezzo: sbagliato, un
   pezzo può avere un `</pre>` orfano all'inizio *e* un `<pre>` orfano alla
   fine, con i conteggi che tornano pari nascondendo due rotture. Va guardato
   l'**ordine** dei tag, portandosi dietro lo stato da un pezzo al successivo.
   Il test l'ha preso al primo giro.

### `MXP` non è un nome

I codici IATA dicono qualcosa solo a chi vola spesso. Gli aeroporti italiani
— quelli da cui si parte — sono ora la città stessa: `TRN` → Torino, `BGY` →
Bergamo Orio. Dove una città ha più scali il nome li distingue, perché
Malpensa e Linate non sono intercambiabili: cambiano come ci arrivi e quanto
ci metti. Un codice sconosciuto resta il codice — meglio tre lettere oneste di
un nome inventato o di uno spazio vuoto.

---

## 2026-08-01 — Da polling a webhook: /cerca diventa davvero istantaneo

Un `/cerca` delle 18:48 senza nessun ack, nemmeno dopo un po' — non un guasto,
lo stesso sintomo già descritto in *"Ogni 15 minuti" non era vero* qualche riga
più sotto, ma stavolta il polling misurato (26-42 minuti reali) non bastava
più: un'attesa a due cifre di minuti per sapere se un comando è partito non è
"su richiesta", è un cron travestito.

Il polling non poteva essere accorciato oltre un certo punto: **non è GitHub
che è lento, è che nulla può restare in ascolto 24/7 senza controllare a
intervalli**, e ogni intervallo, per quanto breve, resta un'attesa minima
strutturale, non un dettaglio di tuning. L'unico modo per avere zero attesa è
capovolgere il flusso: non "qualcosa controlla se hai scritto", ma "Telegram
avvisa nell'istante in cui scrivi" — un webhook, non un poller.

Un webhook richiede un endpoint HTTPS raggiungibile in ogni istante. GitHub
Actions non lo è: un runner esiste solo mentre un job gira. Da qui la prima
vera eccezione architetturale del progetto — un **Cloudflare Worker**
(`cloudflare-worker/`), l'unico pezzo che vive fuori da GitHub. Era la strada
scartata all'inizio per restare senza dipendenze esterne; ma "senza
dipendenze esterne" e "immediato" si sono rivelati incompatibili, e stavolta
a scegliere è stato chi usa il bot, non chi lo scrive.

Il Worker fa solo da citofono: riceve il messaggio, verifica che sia dalla
chat autorizzata (header `X-Telegram-Bot-Api-Secret-Token`, impostato con
`setWebhook`), manda l'ack, e chiama `workflow_dispatch` sullo stesso
`monitor.yml` di sempre — stessa ricerca, stesso snapshot, stesso avviso di
fallimento. Zero logica duplicata: importa direttamente
`src/telegram-commands.js`, che non usa alcuna API di Node (solo `fetch`),
quindi gira identico sul runtime V8 dei Workers e su Node.

**Conseguenza tecnica non ovvia**: un webhook attivo e `getUpdates` sono
mutuamente esclusivi — Telegram consegna gli aggiornamenti o all'uno o
all'altro, mai a entrambi. Il polling non poteva restare come fallback
"nel dubbio": andava ritirato per davvero. Rimossi `telegram-poll.yml`,
`src/telegram-poll.js` e lo stato `data/telegram_offset.json` che gli serviva
— tutti recuperabili dalla history di git se mai servisse tornare indietro.
Sopravvive un workflow ridotto all'osso, `telegram-admin.yml`, per l'unica
cosa che non c'entra con l'ascolto: ripubblicare il menu "/" dei comandi.

Aggiornato anche `/help`, che prometteva "15-45 minuti": una promessa sbagliata
è peggio di nessuna promessa, e ora dice semplicemente "istantaneo".

---

## 2026-08-01 — Una secret mancante non deve azzerare il servizio

Quattro run consecutivi falliti con lo stesso messaggio:

```
❌ Errore fatale: BUDGET_ASIA_AUTUNNO_2026: valore non valido (""), deve essere un numero > 0.
```

La secret non era mai stata creata. Ma il messaggio diceva "valore non
valido", che manda a cercare un errore di battitura in un valore che non
esiste. Dietro c'era un bug vero:

**GitHub Actions inietta una secret inesistente come stringa vuota**, non come
variabile assente. Il codice controllava `raw === undefined` per decidere se
usare il fallback su `config/trips.json`; con `""` quel controllo è falso, si
finiva nel ramo "valore non valido", e il run moriva senza nemmeno provare il
fallback. Ora vuoto e assente sono la stessa cosa: **non fornito**.

Il secondo problema era la reazione: senza budget il monitor si rifiutava di
partire. Corretto per un dato che potrebbe essere sbagliato — ma il budget qui
o c'è o non c'è, e quando non c'è restano comunque i prezzi dei voli, che sono
l'80% del valore di un `/cerca`. Ora il run **degrada invece di morire**:

- classifica per solo prezzo del volo A/R;
- avviso `⚠️ Budget non impostato` **in cima** alla notifica, non a piè di
  pagina: chi legge deve saperlo prima dei numeri, non dopo;
- `feasible: null` (non valutabile) resta distinto da `false` (valutato e
  insufficiente) — un avviso "sotto la durata minima" inventato sarebbe stato
  peggio di nessun avviso;
- un valore *malformato* (`1500 EUR`) continua invece a far fallire il run:
  quello è un refuso, non una scelta.

Altre due cose imparate dallo stesso incidente:

- **Il valore può stare nella tab sbagliata.** *Secrets and variables* ha due
  tab e `secrets.X` non vede ciò che sta in *Variables*. I workflow ora leggono
  `secrets.X || vars.X`. Il repo è privato, quindi una variable non è meno
  riservata di una secret; su repo pubblico la nota resta valida solo per la
  secret.
- **"Non è andata a buon fine" non è un messaggio d'errore.** Il messaggio su
  Telegram ora riporta la riga di errore vera del monitor, estratta dal log del
  run filtrando le sole righe che il programma emette apposta (prefisso ❌).
  Mai l'ambiente, mai l'output grezzo. Serve `set -o pipefail` sulla pipe verso
  `tee`, altrimenti l'exit code sarebbe quello di `tee` e ogni fallimento
  passerebbe per successo.

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
