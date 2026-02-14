"use strict";

const path = require("path");
const express = require("express");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL_NAME = process.env.OPENAI_MODEL || "gpt-5";
const MAX_PROMPT_LENGTH = Number(process.env.MAX_PROMPT_LENGTH || 6000);
const USE_WEB_SEARCH = process.env.OPENAI_USE_WEB_SEARCH === "true";
const OPENAI_REQUEST_TIMEOUT_MS = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS || 35000);

const SYSTEM_INSTRUCTIONS = `
Sei un Prompt Engineer senior.
Trasforma il prompt utente in un prompt molto specifico, pratico e pronto da usare.
Usa lo strumento web_search quando l'argomento beneficia di dati aggiornati.
Non inventare fatti: se un dato non e verificabile, usa un segnaposto esplicito [DA CONFERMARE].
Mantieni la lingua dell'utente.
Restituisci solo il prompt finale, senza spiegazioni.

Il prompt finale deve includere:
- Ruolo dell'assistente
- Obiettivo preciso
- Contesto specifico
- Vincoli e criteri di qualita
- Formato output richiesto
- Istruzione su eventuali domande chiarificatrici (max 3)
`.trim();

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(express.json({ limit: "250kb" }));

app.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && typeof error?.status === "number" && error.status === 400) {
    return res.status(400).json({ error: "JSON non valido nel body della richiesta." });
  }
  return next(error);
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/service-worker.js", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "service-worker.js"));
});

app.use(express.static(path.join(__dirname)));

app.post("/api/improve", async (req, res) => {
  try {
    if (!openai) {
      return res.status(500).json({
        error: "OPENAI_API_KEY non configurata sul server."
      });
    }

    const prompt = normalizePrompt(req.body?.prompt);
    if (!prompt) {
      return res.status(400).json({ error: "Il campo prompt e obbligatorio." });
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({
        error: `Prompt troppo lungo: massimo ${MAX_PROMPT_LENGTH} caratteri.`
      });
    }

    const response = await createImprovementResponse(prompt);

    const output = extractOutputText(response);
    if (!output) {
      return res.status(502).json({ error: "Risposta vuota dal modello." });
    }

    return res.status(200).json({ prompt: output });
  } catch (error) {
    if (isTimeoutError(error)) {
      return res.status(504).json({
        error: `Timeout OpenAI dopo ${OPENAI_REQUEST_TIMEOUT_MS}ms. Riprova o abilita/disabilita OPENAI_USE_WEB_SEARCH.`
      });
    }

    const status = Number(error?.status) || 502;
    const message = typeof error?.message === "string" ? error.message : "Errore chiamata OpenAI.";
    return res.status(status).json({ error: message });
  }
});

app.all("/api/improve", (_req, res) => {
  return res.status(405).json({ error: "Metodo non consentito. Usa POST /api/improve." });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Prompt Forge server in ascolto su http://localhost:${PORT}`);
});

function normalizePrompt(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractOutputText(response) {
  if (response && typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  if (!response || !Array.isArray(response.output)) {
    return "";
  }

  const chunks = [];
  response.output.forEach((item) => {
    if (!item || !Array.isArray(item.content)) {
      return;
    }
    item.content.forEach((part) => {
      if (typeof part?.text === "string" && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    });
  });

  return chunks.join("\n").trim();
}

async function createImprovementResponse(prompt) {
  const basePayload = {
    model: MODEL_NAME,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: SYSTEM_INSTRUCTIONS }]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Migliora questo prompt rendendolo specifico e operativo:\n\n${prompt}`
          }
        ]
      }
    ]
  };

  if (!USE_WEB_SEARCH) {
    return requestOpenAI(basePayload);
  }

  try {
    return await requestOpenAI({
      ...basePayload,
      tools: [{ type: "web_search" }]
    });
  } catch (error) {
    if (isWebSearchUnsupported(error) || isTimeoutError(error)) {
      return requestOpenAI(basePayload);
    }
    throw error;
  }
}

function isWebSearchUnsupported(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("web_search") &&
    (message.includes("unsupported") || message.includes("invalid"))
  );
}

function isTimeoutError(error) {
  return error?.code === "TIMEOUT";
}

async function requestOpenAI(payload) {
  return withTimeout(openai.responses.create(payload), OPENAI_REQUEST_TIMEOUT_MS, "OpenAI");
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const timeoutError = new Error(`${label} timeout (${timeoutMs}ms)`);
      timeoutError.code = "TIMEOUT";
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
