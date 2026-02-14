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
- `OPENAI_USE_WEB_SEARCH`: opzionale, default `true`
- `MAX_PROMPT_LENGTH`: opzionale, default `6000`
- `PORT`: opzionale, default `3000`

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
6. Deploy.
7. Condividi l'URL Render (es. `https://tuo-progetto.onrender.com`) con il tuo amico.

## Note sicurezza

- Non mettere mai la chiave API in `app.js` o in `index.html`.
- Non committare `.env` su Git.
