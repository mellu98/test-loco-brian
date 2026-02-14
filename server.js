"use strict";

const path = require("path");
const express = require("express");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL_NAME = process.env.OPENAI_MODEL || "gpt-5";
const MAX_PROMPT_LENGTH = Number(process.env.MAX_PROMPT_LENGTH || 6000);
const DEFAULT_USE_WEB_SEARCH = process.env.OPENAI_USE_WEB_SEARCH === "true";
const OPENAI_TIMEOUT_NO_WEB_MS = toPositiveInt(process.env.OPENAI_TIMEOUT_NO_WEB_MS, 18000);
const OPENAI_TIMEOUT_WEB_SEARCH_MS = toPositiveInt(process.env.OPENAI_TIMEOUT_WEB_SEARCH_MS, 12000);
const MAX_OUTPUT_TOKENS = toPositiveInt(process.env.MAX_OUTPUT_TOKENS, 700);

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
    const useWebSearch = parseUseWebSearch(req.body?.useWebSearch, DEFAULT_USE_WEB_SEARCH);
    if (!prompt) {
      return res.status(400).json({ error: "Il campo prompt e obbligatorio." });
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({
        error: `Prompt troppo lungo: massimo ${MAX_PROMPT_LENGTH} caratteri.`
      });
    }

    const result = await createImprovementResponse(prompt, useWebSearch);

    const output = extractOutputText(result.response);
    if (!output) {
      return res.status(502).json({ error: "Risposta vuota dal modello." });
    }

    return res.status(200).json({
      prompt: output,
      usedWebSearch: result.usedWebSearch,
      fallbackToNoWebSearch: result.fallbackToNoWebSearch
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      const timeoutMs = Number(error?.timeoutMs) || OPENAI_TIMEOUT_NO_WEB_MS;
      const label = typeof error?.label === "string" ? error.label : "OpenAI";
      return res.status(504).json({
        error: `Timeout ${label} dopo ${timeoutMs}ms. Riprova senza web research o riduci il prompt.`
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

function parseUseWebSearch(value, fallbackValue) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return fallbackValue;
}

function toPositiveInt(value, fallbackValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return Math.floor(parsed);
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

async function createImprovementResponse(prompt, useWebSearch) {
  const basePayload = {
    model: MODEL_NAME,
    max_output_tokens: MAX_OUTPUT_TOKENS,
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

  if (!useWebSearch) {
    return {
      response: await requestOpenAI(basePayload, OPENAI_TIMEOUT_NO_WEB_MS, "OpenAI"),
      usedWebSearch: false,
      fallbackToNoWebSearch: false
    };
  }

  try {
    return {
      response: await requestOpenAI(
        {
          ...basePayload,
          tools: [{ type: "web_search" }]
        },
        OPENAI_TIMEOUT_WEB_SEARCH_MS,
        "OpenAI+web_search"
      ),
      usedWebSearch: true,
      fallbackToNoWebSearch: false
    };
  } catch (error) {
    if (isWebSearchUnsupported(error) || isTimeoutError(error)) {
      return {
        response: await requestOpenAI(basePayload, OPENAI_TIMEOUT_NO_WEB_MS, "OpenAI fallback"),
        usedWebSearch: false,
        fallbackToNoWebSearch: true
      };
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
  const message = String(error?.message || "").toLowerCase();
  return (
    error?.code === "TIMEOUT" ||
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

async function requestOpenAI(payload, timeoutMs, label) {
  return withTimeout(openai.responses.create(payload), timeoutMs, label);
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const timeoutError = new Error(`${label} timeout (${timeoutMs}ms)`);
      timeoutError.code = "TIMEOUT";
      timeoutError.timeoutMs = timeoutMs;
      timeoutError.label = label;
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
