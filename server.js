"use strict";

const path = require("path");
const express = require("express");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL_NAME = process.env.OPENAI_MODEL || "gpt-5";
const MAX_PROMPT_LENGTH = Number(process.env.MAX_PROMPT_LENGTH || 6000);
const OPENAI_TIMEOUT_WEB_SEARCH_MS = toPositiveInt(process.env.OPENAI_TIMEOUT_WEB_SEARCH_MS, 30000);
const OPENAI_TIMEOUT_RETRIES = toPositiveInt(process.env.OPENAI_TIMEOUT_RETRIES, 2);
const OPENAI_TIMEOUT_RETRY_DELTA_MS = toPositiveInt(process.env.OPENAI_TIMEOUT_RETRY_DELTA_MS, 15000);
const OPENAI_POLL_INTERVAL_MS = toPositiveInt(process.env.OPENAI_POLL_INTERVAL_MS, 1200);
const OPENAI_POLL_MAX_WAIT_MS = toPositiveInt(process.env.OPENAI_POLL_MAX_WAIT_MS, 45000);
const MAX_OUTPUT_TOKENS = toPositiveInt(process.env.MAX_OUTPUT_TOKENS, 550);

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

    const result = await createImprovementResponse(prompt);
    let output = extractOutputText(result.response);
    let refusal = extractRefusalText(result.response);
    let recoveredFromEmptyOutput = false;

    if (!output) {
      const retryReason = getIncompleteReason(result.response);
      const retryResponse = await requestDirectTextFallback(
        prompt,
        retryReason === "max_output_tokens"
      );
      output = extractOutputText(retryResponse);
      if (!refusal) {
        refusal = extractRefusalText(retryResponse);
      }
      recoveredFromEmptyOutput = Boolean(output);
    }

    if (!output && !refusal && typeof result.response?.id === "string" && result.response.id) {
      const finalizedResponse = await requestFinalizeFromPreviousResponse(result.response.id);
      output = extractOutputText(finalizedResponse);
      if (!refusal) {
        refusal = extractRefusalText(finalizedResponse);
      }
      recoveredFromEmptyOutput = Boolean(output);
    }

    if (!output) {
      if (refusal) {
        return res.status(422).json({ error: refusal });
      }

      return res.status(502).json({
        error:
          "Risposta vuota dal modello dopo retry automatico. Riprova o aumenta MAX_OUTPUT_TOKENS."
      });
    }

    return res.status(200).json({
      prompt: output,
      recoveredFromEmptyOutput,
      usedWebSearch: true,
      usedModel: MODEL_NAME
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      const timeoutMs = Number(error?.timeoutMs) || OPENAI_TIMEOUT_WEB_SEARCH_MS;
      const label = typeof error?.label === "string" ? error.label : "OpenAI";
      const attempts = Number(error?.attempts) || 1;
      return res.status(504).json({
        error: `Timeout ${label} dopo ${timeoutMs}ms (tentativi: ${attempts}). Riprova con un prompt piu corto.`
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

  if (
    response &&
    Array.isArray(response.output_text) &&
    response.output_text.length > 0
  ) {
    const textFromArray = response.output_text
      .map((part) => (typeof part === "string" ? part.trim() : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (textFromArray) {
      return textFromArray;
    }
  }

  if (!response || !Array.isArray(response.output)) {
    return extractTextFromChoices(response);
  }

  const chunks = [];
  response.output.forEach((item) => {
    if (typeof item?.text === "string" && item.text.trim()) {
      chunks.push(item.text.trim());
    }

    if (typeof item?.content === "string" && item.content.trim()) {
      chunks.push(item.content.trim());
      return;
    }

    if (!item || !Array.isArray(item.content)) {
      return;
    }
    item.content.forEach((part) => {
      if (typeof part === "string" && part.trim()) {
        chunks.push(part.trim());
        return;
      }
      if (part?.type === "output_text" && typeof part?.text === "string" && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    });
  });

  const output = chunks.join("\n").trim();
  if (output) {
    return output;
  }

  return extractTextFromChoices(response);
}

function extractRefusalText(response) {
  const chunks = [];

  if (Array.isArray(response?.output)) {
    response.output.forEach((item) => {
      if (typeof item?.refusal === "string" && item.refusal.trim()) {
        chunks.push(item.refusal.trim());
      }

      if (!Array.isArray(item?.content)) {
        return;
      }

      item.content.forEach((part) => {
        if (typeof part?.refusal === "string" && part.refusal.trim()) {
          chunks.push(part.refusal.trim());
          return;
        }

        if (part?.type === "refusal" && typeof part?.text === "string" && part.text.trim()) {
          chunks.push(part.text.trim());
        }
      });
    });
  }

  if (chunks.length > 0) {
    return chunks.join("\n").trim();
  }

  const choices = Array.isArray(response?.choices) ? response.choices : [];
  const refusalChunks = [];
  choices.forEach((choice) => {
    const directRefusal = choice?.message?.refusal;
    if (typeof directRefusal === "string" && directRefusal.trim()) {
      refusalChunks.push(directRefusal.trim());
      return;
    }

    const content = choice?.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    content.forEach((part) => {
      if (typeof part?.refusal === "string" && part.refusal.trim()) {
        refusalChunks.push(part.refusal.trim());
      }
    });
  });

  return refusalChunks.join("\n").trim();
}

function getIncompleteReason(response) {
  return response?.incomplete_details?.reason || "";
}

function extractTextFromChoices(response) {
  const choices = Array.isArray(response?.choices) ? response.choices : [];
  if (choices.length === 0) {
    return "";
  }

  const chunks = [];
  choices.forEach((choice) => {
    const content = choice?.message?.content;
    if (typeof content === "string" && content.trim()) {
      chunks.push(content.trim());
      return;
    }

    if (Array.isArray(content)) {
      content.forEach((part) => {
        if (typeof part === "string" && part.trim()) {
          chunks.push(part.trim());
          return;
        }
        if (typeof part?.text === "string" && part.text.trim()) {
          chunks.push(part.text.trim());
        }
      });
    }
  });

  return chunks.join("\n").trim();
}

async function createImprovementResponse(prompt) {
  const basePayload = buildBasePayload(prompt, undefined, MODEL_NAME);
  const response = await requestOpenAIWithTimeoutRetry(
    {
      ...basePayload,
      tools: [{ type: "web_search" }]
    },
    OPENAI_TIMEOUT_WEB_SEARCH_MS,
    "OpenAI+web_search"
  );

  return {
    response
  };
}

function buildBasePayload(prompt, userInstructionText, modelName, maxOutputTokensOverride) {
  const payload = {
    model: modelName || MODEL_NAME,
    text: {
      verbosity: "low"
    },
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
            text: userInstructionText || `Migliora questo prompt rendendolo specifico e operativo:\n\n${prompt}`
          }
        ]
      }
    ]
  };

  const maxOutputTokens = Number.isFinite(maxOutputTokensOverride)
    ? Math.floor(maxOutputTokensOverride)
    : MAX_OUTPUT_TOKENS;

  if (maxOutputTokens > 0) {
    payload.max_output_tokens = maxOutputTokens;
  }

  return payload;
}

async function requestDirectTextFallback(prompt) {
  const retryInstruction = [
    "Genera direttamente il prompt finale ottimizzato in testo semplice.",
    "Nessuna spiegazione extra.",
    "",
    "Prompt di partenza:",
    prompt
  ].join("\n");

  const boostedMaxOutputTokens = MAX_OUTPUT_TOKENS > 0
    ? Math.max(MAX_OUTPUT_TOKENS, 1100)
    : undefined;

  return requestOpenAIWithTimeoutRetry(
    {
      ...buildBasePayload(prompt, retryInstruction, MODEL_NAME, boostedMaxOutputTokens),
      tools: [{ type: "web_search" }]
    },
    OPENAI_TIMEOUT_WEB_SEARCH_MS,
    "OpenAI+web_search retry-empty-output"
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
  const created = await withTimeout(openai.responses.create(payload), timeoutMs, label);
  return waitForResponseCompletion(created, label);
}

async function requestFinalizeFromPreviousResponse(previousResponseId) {
  const finalizeInstruction = [
    "Usa i risultati gia raccolti e restituisci ORA solo il prompt finale ottimizzato.",
    "Output testuale puro, nessuna introduzione e nessuna spiegazione."
  ].join("\n");

  return requestOpenAIWithTimeoutRetry(
    {
      model: MODEL_NAME,
      previous_response_id: previousResponseId,
      text: { verbosity: "low" },
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: finalizeInstruction }]
        }
      ],
      max_output_tokens: Math.max(MAX_OUTPUT_TOKENS, 1100)
    },
    OPENAI_TIMEOUT_WEB_SEARCH_MS,
    "OpenAI finalize-from-previous"
  );
}

async function waitForResponseCompletion(initialResponse, label) {
  let response = initialResponse;
  let waitedMs = 0;

  while (isPendingResponseStatus(response?.status)) {
    if (!response?.id) {
      break;
    }

    if (waitedMs >= OPENAI_POLL_MAX_WAIT_MS) {
      const timeoutError = new Error(`${label} polling timeout (${OPENAI_POLL_MAX_WAIT_MS}ms)`);
      timeoutError.code = "TIMEOUT";
      timeoutError.timeoutMs = OPENAI_POLL_MAX_WAIT_MS;
      timeoutError.label = `${label} polling`;
      throw timeoutError;
    }

    await sleep(OPENAI_POLL_INTERVAL_MS);
    waitedMs += OPENAI_POLL_INTERVAL_MS;
    response = await withTimeout(
      openai.responses.retrieve(response.id),
      OPENAI_TIMEOUT_WEB_SEARCH_MS,
      `${label} retrieve`
    );
  }

  return response;
}

function isPendingResponseStatus(status) {
  return status === "queued" || status === "in_progress";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestOpenAIWithTimeoutRetry(payload, firstTimeoutMs, label) {
  let timeoutMs = firstTimeoutMs;
  let lastTimeoutError = null;

  for (let attempt = 0; attempt <= OPENAI_TIMEOUT_RETRIES; attempt += 1) {
    const attemptLabel = attempt === 0 ? label : `${label} retry-${attempt}`;
    try {
      return await requestOpenAI(payload, timeoutMs, attemptLabel);
    } catch (error) {
      if (!isTimeoutError(error)) {
        throw error;
      }

      lastTimeoutError = error;
      if (attempt === OPENAI_TIMEOUT_RETRIES) {
        lastTimeoutError.attempts = OPENAI_TIMEOUT_RETRIES + 1;
        throw lastTimeoutError;
      }

      timeoutMs += OPENAI_TIMEOUT_RETRY_DELTA_MS;
    }
  }

  if (lastTimeoutError) {
    lastTimeoutError.attempts = OPENAI_TIMEOUT_RETRIES + 1;
    throw lastTimeoutError;
  }

  throw new Error(`${label} failed without timeout details.`);
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
