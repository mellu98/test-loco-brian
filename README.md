# Prompt Forge

App web semplice: incolli un prompt grezzo, il backend lo passa a ChatGPT e restituisce un prompt molto piu specifico.

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
- `OPENAI_USE_WEB_SEARCH`: default server se il toggle UI non viene inviato, default `false`
- `OPENAI_TIMEOUT_NO_WEB_MS`: timeout richieste senza web research, default `18000`
- `OPENAI_TIMEOUT_WEB_SEARCH_MS`: timeout richieste con web research, default `12000`
- `MAX_OUTPUT_TOKENS`: limita la lunghezza output per ridurre latenza, default `700`
- `MAX_PROMPT_LENGTH`: opzionale, default `6000`
- `PORT`: opzionale, default `3000`

## Web Research (toggle)

- Nel form trovi il toggle `Usa web research`.
- Toggle OFF: modalita piu veloce.
- Toggle ON: prova prima con ricerca web e, se lenta/non supportata, fa fallback automatico senza web research.

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
   - `OPENAI_TIMEOUT_NO_WEB_MS` = `18000` (opzionale)
   - `OPENAI_TIMEOUT_WEB_SEARCH_MS` = `12000` (opzionale)
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

## Note sicurezza

- Non mettere mai la chiave API in `app.js` o in `index.html`.
- Non committare `.env` su Git.
