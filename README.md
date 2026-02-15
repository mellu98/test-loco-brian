# Prompt Forge

App web semplice: incolli un prompt grezzo, il backend lo passa a ChatGPT e restituisce un prompt molto piu specifico.

## Release 1.0.1

- Stabilizzato il recupero quando OpenAI restituisce output vuoto o incompleto.
- Migliorata la gestione dei timeout e degli errori upstream 5xx (niente blocco UI).
- Fallback locale tematico (marketing, coding, studio, salute) con messaggi debug utili.
- PWA aggiornata con gestione cache piu affidabile.

## Requisiti

- Node.js 18+ (consigliato 20+)
- OpenAI API key valida

## Avvio in locale

1. Installa dipendenze:
   - `npm install`
2. Crea `.env` da `.env.example` e inserisci la chiave:
   - `OPENAI_API_KEY=...`
3. Avvia:
   - `npm start`
4. Apri:
   - `http://localhost:3000`

## Configurazione ambiente

- `OPENAI_API_KEY`: obbligatoria
- `OPENAI_MODEL`: opzionale, default `gpt-5`
- `OPENAI_TIMEOUT_WEB_SEARCH_MS`: timeout base richieste con web research, default `30000`
- `OPENAI_TIMEOUT_RETRIES`: numero retry automatici su timeout, default `2`
- `OPENAI_TIMEOUT_RETRY_DELTA_MS`: incremento timeout per ogni retry, default `15000`
- `OPENAI_POLL_INTERVAL_MS`: intervallo polling quando la response e `queued/in_progress`, default `1200`
- `OPENAI_POLL_MAX_WAIT_MS`: attesa massima totale del polling, default `45000`
- `MAX_OUTPUT_TOKENS`: limita la lunghezza output per ridurre latenza, default `550`
- `MAX_PROMPT_LENGTH`: opzionale, default `6000`
- `LOG_EMPTY_OUTPUT_TRACE`: opzionale, default `1`. Se `1`, logga su server un evento JSON quando il primo tentativo non produce testo.
- `PORT`: opzionale, default `3000`

## Debug risposta vuota (primo tentativo)

Quando il frontend mostra `Il modello ha risposto vuoto al primo tentativo`, ora hai diagnostica strutturata:

- **Browser status**: mostra un hint compatto (`cause=...`, `types=...`, `tok=...`, `id=...`).
- **Browser console**: log `Debug modello (/api/improve)` con il payload completo.
- **Server logs**: evento `[debug-empty-output] { ... }` con trace di ogni step.

Campi chiave:

- `diagnosis.root_cause`: causa stimata (`web_search_without_final_text`, `max_output_tokens_reached`, ecc.).
- `first_attempt`: dettagli del primo tentativo (status, incomplete_reason, output_types, token usage, tempi).
- `trace`: sequenza completa dei tentativi di recupero.
- `request_id`: ID correlabile tra UI e log server.

## Web Research

- La web research e sempre attiva.
- Il backend usa sempre il modello GPT primario configurato in `OPENAI_MODEL`.
- Nel frontend non c'e piu il toggle di attivazione/disattivazione.
- Se il provider non restituisce testo anche dopo retry, il server restituisce un fallback locale per evitare errore bloccante.

## Deploy online (Render)

1. Pubblica il progetto su GitHub.
2. Vai su Render -> `New` -> `Web Service`.
3. Collega il repository.
4. Imposta:
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
5. In `Environment Variables` aggiungi:
   - `OPENAI_API_KEY` = tua chiave OpenAI
   - `OPENAI_MODEL` = `gpt-5` (opzionale)
   - `OPENAI_TIMEOUT_WEB_SEARCH_MS` = `30000` (opzionale)
   - `OPENAI_TIMEOUT_RETRIES` = `2` (opzionale)
   - `OPENAI_TIMEOUT_RETRY_DELTA_MS` = `15000` (opzionale)
   - `OPENAI_POLL_INTERVAL_MS` = `1200` (opzionale)
   - `OPENAI_POLL_MAX_WAIT_MS` = `45000` (opzionale)
   - `MAX_OUTPUT_TOKENS` = `550` (opzionale)
6. Deploy.
7. Condividi l'URL Render (es. `https://tuo-progetto.onrender.com`) con il tuo amico.

## Installazione PWA su telefono

L'app ora e configurata come PWA installabile.

- Android (Chrome):
  1. Apri l'URL HTTPS dell'app.
  2. Tocca menu browser -> `Installa app` (o `Aggiungi a schermata Home`).
- iPhone (Safari):
  1. Apri l'URL HTTPS dell'app.
  2. Tocca Condividi -> `Aggiungi alla schermata Home`.

Note importanti:
- Per installazione su telefono serve `https://` (tranne `http://localhost` in locale).
- Dopo modifiche PWA, se non vedi subito gli aggiornamenti, chiudi e riapri l'app installata.
- Se il frontend sembra non aggiornarsi, disinstalla e reinstalla la PWA per forzare l'ultimo service worker.

## Note sicurezza

- Non mettere mai la chiave API in `app.js` o in `index.html`.
- Non committare `.env` su Git.
