"use strict";

const { randomUUID } = require("crypto");
const path = require("path");
const express = require("express");
const OpenAI = require("openai");
require("dotenv").config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL_NAME = process.env.OPENAI_MODEL || "gpt-5";
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || "").trim();
const AI_PROVIDER = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
const MAX_PROMPT_LENGTH = Number(process.env.MAX_PROMPT_LENGTH || 6000);
const OPENAI_TIMEOUT_WEB_SEARCH_MS = toPositiveInt(process.env.OPENAI_TIMEOUT_WEB_SEARCH_MS, 30000);
const OPENAI_TIMEOUT_RETRIES = toPositiveInt(process.env.OPENAI_TIMEOUT_RETRIES, 2);
const OPENAI_TIMEOUT_RETRY_DELTA_MS = toPositiveInt(process.env.OPENAI_TIMEOUT_RETRY_DELTA_MS, 15000);
const OPENAI_POLL_INTERVAL_MS = toPositiveInt(process.env.OPENAI_POLL_INTERVAL_MS, 1200);
const OPENAI_POLL_MAX_WAIT_MS = toPositiveInt(process.env.OPENAI_POLL_MAX_WAIT_MS, 45000);
const MAX_OUTPUT_TOKENS = toPositiveInt(process.env.MAX_OUTPUT_TOKENS, 550);
const DEBUG_TRACE_VERSION = "2026-02-15";
const LOG_EMPTY_OUTPUT_TRACE = process.env.LOG_EMPTY_OUTPUT_TRACE !== "0";
const MODEL_NAME_LOWER = String(MODEL_NAME || "").toLowerCase();
const BASE_URL_LOWER = OPENAI_BASE_URL.toLowerCase();
const USE_CHAT_COMPLETIONS_API =
  AI_PROVIDER === "deepseek" ||
  MODEL_NAME_LOWER.startsWith("deepseek") ||
  BASE_URL_LOWER.includes("deepseek.com");

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
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {})
    })
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

app.get("/app.js", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "app.js"));
});

app.get("/index.html", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/styles.css", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "styles.css"));
});

app.use(express.static(path.join(__dirname)));

app.post("/api/improve", async (req, res) => {
  const requestId = randomUUID();
  const requestStartedAt = Date.now();
  const trace = [];
  let prompt = "";
  res.set("X-Debug-Request-Id", requestId);

  try {
    if (!openai) {
      return res.status(500).json({
        error: "OPENAI_API_KEY non configurata sul server.",
        requestId
      });
    }

    prompt = normalizePrompt(req.body?.prompt);
    if (!prompt) {
      return res.status(400).json({ error: "Il campo prompt e obbligatorio.", requestId });
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({
        error: `Prompt troppo lungo: massimo ${MAX_PROMPT_LENGTH} caratteri.`,
        requestId
      });
    }

    const initialStartedAt = Date.now();
    const result = await createImprovementResponse(prompt);
    let lastResponse = result.response;
    pushDebugTrace(
      trace,
      "initial_web_search",
      lastResponse,
      Date.now() - initialStartedAt
    );

    let finalDebug = buildResponseDebugInfo(lastResponse);
    let output = extractOutputText(lastResponse);
    let refusal = extractRefusalText(lastResponse);
    let recoveredFromEmptyOutput = false;
    let usedNoWebRecovery = false;

    if (!output) {
      const retryReason = getIncompleteReason(lastResponse);
      const retryStartedAt = Date.now();
      const retryResponse = await requestDirectTextFallback(
        prompt,
        retryReason === "max_output_tokens"
      );
      lastResponse = retryResponse;
      pushDebugTrace(
        trace,
        "retry_web_search_direct_text",
        lastResponse,
        Date.now() - retryStartedAt,
        { trigger_reason: retryReason || "empty_output" }
      );
      finalDebug = buildResponseDebugInfo(retryResponse);
      output = extractOutputText(retryResponse);
      if (!refusal) {
        refusal = extractRefusalText(retryResponse);
      }
      recoveredFromEmptyOutput = Boolean(output);
    }

    if (!output && !refusal && typeof lastResponse?.id === "string" && lastResponse.id) {
      const finalizeReason = getIncompleteReason(lastResponse);
      const finalizeStartedAt = Date.now();
      const finalizedResponse = await requestFinalizeFromPreviousResponse(
        lastResponse.id,
        finalizeReason === "max_output_tokens",
        prompt
      );
      lastResponse = finalizedResponse;
      pushDebugTrace(
        trace,
        "finalize_from_previous_web_search",
        lastResponse,
        Date.now() - finalizeStartedAt,
        { trigger_reason: finalizeReason || "empty_output" }
      );
      finalDebug = buildResponseDebugInfo(finalizedResponse);
      output = extractOutputText(finalizedResponse);
      if (!refusal) {
        refusal = extractRefusalText(finalizedResponse);
      }
      recoveredFromEmptyOutput = Boolean(output);
    }

    if (!output && !refusal) {
      const modelOnlyReason = getIncompleteReason(lastResponse);
      const modelOnlyStartedAt = Date.now();
      const modelOnlyResponse = await requestModelOnlyFallback(
        prompt,
        modelOnlyReason === "max_output_tokens"
      );
      lastResponse = modelOnlyResponse;
      pushDebugTrace(
        trace,
        "retry_model_only",
        lastResponse,
        Date.now() - modelOnlyStartedAt,
        { trigger_reason: modelOnlyReason || "empty_output" }
      );
      finalDebug = buildResponseDebugInfo(modelOnlyResponse);
      output = extractOutputText(modelOnlyResponse);
      if (!refusal) {
        refusal = extractRefusalText(modelOnlyResponse);
      }
      if (output) {
        recoveredFromEmptyOutput = true;
        usedNoWebRecovery = true;
      }
    }

    if (!output && !refusal && typeof lastResponse?.id === "string" && lastResponse.id) {
      const finalizeModelReason = getIncompleteReason(lastResponse);
      const finalizeModelStartedAt = Date.now();
      const finalizedModelOnlyResponse = await requestFinalizeFromPreviousResponse(
        lastResponse.id,
        finalizeModelReason === "max_output_tokens",
        prompt
      );
      lastResponse = finalizedModelOnlyResponse;
      pushDebugTrace(
        trace,
        "finalize_from_previous_model_only",
        lastResponse,
        Date.now() - finalizeModelStartedAt,
        { trigger_reason: finalizeModelReason || "empty_output" }
      );
      finalDebug = buildResponseDebugInfo(finalizedModelOnlyResponse);
      output = extractOutputText(finalizedModelOnlyResponse);
      if (!refusal) {
        refusal = extractRefusalText(finalizedModelOnlyResponse);
      }
      if (output) {
        recoveredFromEmptyOutput = true;
        usedNoWebRecovery = true;
      }
    }

    if (!output) {
      const debugPayload = buildResponseDebugPayload({
        requestId,
        trace,
        finalDebug,
        recoveredFromEmptyOutput: true,
        usedNoWebRecovery,
        usedLocalFallback: !refusal,
        totalElapsedMs: Date.now() - requestStartedAt
      });

      if (shouldLogEmptyOutputDebug(debugPayload)) {
        logEmptyOutputDebug(debugPayload);
      }

      if (refusal) {
        return res.status(422).json({
          error: refusal,
          requestId,
          debug: debugPayload
        });
      }

      return res.status(200).json({
        prompt: buildLocalFallbackPrompt(prompt),
        recoveredFromEmptyOutput: true,
        usedWebSearch: true,
        usedModel: MODEL_NAME,
        usedLocalFallback: true,
        usedNoWebRecovery,
        requestId,
        debug: debugPayload
      });
    }

    const debugPayload = buildResponseDebugPayload({
      requestId,
      trace,
      finalDebug,
      recoveredFromEmptyOutput,
      usedNoWebRecovery,
      usedLocalFallback: false,
      totalElapsedMs: Date.now() - requestStartedAt
    });

    if (shouldLogEmptyOutputDebug(debugPayload)) {
      logEmptyOutputDebug(debugPayload);
    }

    return res.status(200).json({
      prompt: output,
      recoveredFromEmptyOutput,
      usedWebSearch: true,
      usedModel: MODEL_NAME,
      usedNoWebRecovery,
      requestId,
      debug: debugPayload
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      const timeoutMs = Number(error?.timeoutMs) || OPENAI_TIMEOUT_WEB_SEARCH_MS;
      const label = typeof error?.label === "string" ? error.label : "OpenAI";
      const attempts = Number(error?.attempts) || 1;

      const errorDebug = {
        timeout_label: label,
        timeout_ms: timeoutMs,
        attempts
      };

      const debugPayload = buildResponseDebugPayload({
        requestId,
        trace,
        finalDebug: null,
        recoveredFromEmptyOutput: Boolean(prompt),
        usedNoWebRecovery: false,
        usedLocalFallback: Boolean(prompt),
        totalElapsedMs: Date.now() - requestStartedAt,
        errorDebug
      });

      if (shouldLogEmptyOutputDebug(debugPayload)) {
        logEmptyOutputDebug(debugPayload);
      }

      if (prompt) {
        return res.status(200).json({
          prompt: buildLocalFallbackPrompt(prompt),
          recoveredFromEmptyOutput: true,
          usedWebSearch: true,
          usedModel: MODEL_NAME,
          usedLocalFallback: true,
          requestId,
          debug: debugPayload
        });
      }

      return res.status(504).json({
        error: `Timeout ${label} dopo ${timeoutMs}ms (tentativi: ${attempts}). Riprova con un prompt piu corto.`,
        requestId,
        debug: debugPayload
      });
    }

    const status = Number(error?.status) || 502;
    const rawMessage = typeof error?.message === "string" ? error.message : "Errore chiamata OpenAI.";
    const message = redactSensitiveText(rawMessage);
    const errorDebug = {
      upstream_status: status,
      upstream_error: message
    };

    const debugPayload = buildResponseDebugPayload({
      requestId,
      trace,
      finalDebug: null,
      recoveredFromEmptyOutput: Boolean(prompt && status >= 500),
      usedNoWebRecovery: false,
      usedLocalFallback: Boolean(prompt && status >= 500),
      totalElapsedMs: Date.now() - requestStartedAt,
      errorDebug
    });

    if (shouldLogEmptyOutputDebug(debugPayload)) {
      logEmptyOutputDebug(debugPayload);
    }

    if (prompt && status >= 500) {
      return res.status(200).json({
        prompt: buildLocalFallbackPrompt(prompt),
        recoveredFromEmptyOutput: true,
        usedWebSearch: true,
        usedModel: MODEL_NAME,
        usedLocalFallback: true,
        requestId,
        debug: debugPayload
      });
    }

    return res.status(status).json({
      error: message,
      requestId,
      debug: debugPayload
    });
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
      .map((part) => {
        if (typeof part === "string") {
          return part.trim();
        }
        if (typeof part?.text === "string") {
          return part.text.trim();
        }
        if (typeof part?.value === "string") {
          return part.value.trim();
        }
        return "";
      })
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
      if (typeof part?.text === "string" && part.text.trim()) {
        chunks.push(part.text.trim());
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

function buildResponseDebugInfo(response) {
  const outputItems = Array.isArray(response?.output) ? response.output : [];
  const outputTypes = outputItems.map((item) => item?.type || "unknown");
  const outputText = extractOutputText(response);
  const refusalText = extractRefusalText(response);
  const usage = extractUsageStats(response);

  const hasOutputText = outputItems.some((item) => {
    if (typeof item?.text === "string" && item.text.trim()) {
      return true;
    }
    if (!Array.isArray(item?.content)) {
      return false;
    }
    return item.content.some((part) => {
      if (typeof part === "string" && part.trim()) {
        return true;
      }
      return part?.type === "output_text" && typeof part?.text === "string" && part.text.trim();
    });
  });

  const hasRefusal = outputItems.some((item) => {
    if (typeof item?.refusal === "string" && item.refusal.trim()) {
      return true;
    }
    if (!Array.isArray(item?.content)) {
      return false;
    }
    return item.content.some((part) => {
      if (typeof part?.refusal === "string" && part.refusal.trim()) {
        return true;
      }
      return part?.type === "refusal" && typeof part?.text === "string" && part.text.trim();
    });
  });

  const hasWebSearchCall = outputTypes.some((type) =>
    String(type || "").toLowerCase().includes("web_search")
  );

  return {
    response_id: response?.id || "",
    status: response?.status || "",
    incomplete_reason: getIncompleteReason(response),
    output_count: outputItems.length,
    output_types: outputTypes,
    has_web_search_call: hasWebSearchCall,
    has_output_text: Boolean(hasOutputText || outputText.length > 0),
    has_refusal: Boolean(hasRefusal || refusalText.length > 0),
    output_text_length: outputText.length,
    refusal_length: refusalText.length,
    usage_input_tokens: usage.input_tokens,
    usage_output_tokens: usage.output_tokens,
    usage_total_tokens: usage.total_tokens,
    usage_reasoning_tokens: usage.reasoning_tokens
  };
}

function pushDebugTrace(trace, step, response, elapsedMs, extra) {
  if (!Array.isArray(trace)) {
    return;
  }

  const base = buildResponseDebugInfo(response);
  const entry = {
    step,
    elapsed_ms: toFiniteNumber(elapsedMs),
    ...base
  };

  if (extra && typeof extra === "object") {
    Object.keys(extra).forEach((key) => {
      const value = extra[key];
      if (value === undefined) {
        return;
      }
      entry[key] = value;
    });
  }

  trace.push(entry);
}

function buildResponseDebugPayload({
  requestId,
  trace,
  finalDebug,
  recoveredFromEmptyOutput,
  usedNoWebRecovery,
  usedLocalFallback,
  totalElapsedMs,
  errorDebug
}) {
  const safeTrace = Array.isArray(trace) ? trace.slice() : [];
  const diagnosis = buildEmptyOutputDiagnosis(safeTrace);
  const firstAttempt = safeTrace.length > 0 ? safeTrace[0] : null;
  const payload = {
    debug_version: DEBUG_TRACE_VERSION,
    request_id: requestId,
    recovered_from_empty_output: Boolean(recoveredFromEmptyOutput),
    used_no_web_recovery: Boolean(usedNoWebRecovery),
    used_local_fallback: Boolean(usedLocalFallback),
    total_elapsed_ms: toFiniteNumber(totalElapsedMs),
    diagnosis,
    first_attempt: firstAttempt,
    final_attempt: finalDebug && typeof finalDebug === "object" ? finalDebug : null,
    trace: safeTrace
  };

  if (errorDebug && typeof errorDebug === "object") {
    payload.error = errorDebug;
    if (typeof errorDebug.timeout_label === "string") {
      payload.timeout_label = errorDebug.timeout_label;
    }
    if (Number.isFinite(Number(errorDebug.timeout_ms))) {
      payload.timeout_ms = Number(errorDebug.timeout_ms);
    }
    if (Number.isFinite(Number(errorDebug.attempts))) {
      payload.attempts = Number(errorDebug.attempts);
    }
    if (Number.isFinite(Number(errorDebug.upstream_status))) {
      payload.upstream_status = Number(errorDebug.upstream_status);
    }
    if (typeof errorDebug.upstream_error === "string") {
      payload.upstream_error = errorDebug.upstream_error;
    }
  }

  return payload;
}

function buildEmptyOutputDiagnosis(trace) {
  const firstAttempt = Array.isArray(trace) && trace.length > 0 ? trace[0] : null;
  if (!firstAttempt) {
    return {
      root_cause: "missing_first_attempt_trace",
      summary: "Nessuna traccia del primo tentativo disponibile."
    };
  }

  if (firstAttempt.has_output_text) {
    return {
      root_cause: "no_empty_output_first_attempt",
      summary: "Il primo tentativo ha gia prodotto testo utile."
    };
  }

  if (firstAttempt.has_refusal) {
    return {
      root_cause: "first_attempt_refusal",
      summary: "Il primo tentativo contiene una refusal e non testo utilizzabile."
    };
  }

  if (firstAttempt.incomplete_reason === "max_output_tokens") {
    return {
      root_cause: "max_output_tokens_reached",
      summary: "Il primo tentativo e stato interrotto per limite token."
    };
  }

  if (typeof firstAttempt.status === "string" && firstAttempt.status && firstAttempt.status !== "completed") {
    return {
      root_cause: "first_attempt_not_completed",
      summary: `Il primo tentativo e terminato con status=${firstAttempt.status}.`
    };
  }

  if (firstAttempt.has_web_search_call && !firstAttempt.has_output_text) {
    return {
      root_cause: "web_search_without_final_text",
      summary: "Il primo tentativo ha eseguito web_search ma non ha emesso output_text finale."
    };
  }

  if (Number(firstAttempt.output_count) === 0) {
    return {
      root_cause: "first_attempt_no_output_items",
      summary: "Il primo tentativo non contiene elementi in output."
    };
  }

  return {
    root_cause: "first_attempt_non_text_output",
    summary: "Il primo tentativo contiene output non testuale."
  };
}

function shouldLogEmptyOutputDebug(debugPayload) {
  if (!LOG_EMPTY_OUTPUT_TRACE || !debugPayload || typeof debugPayload !== "object") {
    return false;
  }

  if (debugPayload.used_local_fallback || debugPayload.recovered_from_empty_output) {
    return true;
  }

  const rootCause = debugPayload?.diagnosis?.root_cause || "";
  return rootCause !== "no_empty_output_first_attempt";
}

function logEmptyOutputDebug(debugPayload) {
  try {
    const event = {
      request_id: debugPayload?.request_id || "",
      root_cause: debugPayload?.diagnosis?.root_cause || "unknown",
      summary: debugPayload?.diagnosis?.summary || "",
      total_elapsed_ms: debugPayload?.total_elapsed_ms,
      first_attempt: debugPayload?.first_attempt || null,
      final_attempt: debugPayload?.final_attempt || null,
      trace: Array.isArray(debugPayload?.trace) ? debugPayload.trace : [],
      error: debugPayload?.error || null
    };
    console.warn(`[debug-empty-output] ${JSON.stringify(event)}`);
  } catch (_error) {
    console.warn("[debug-empty-output] Impossibile serializzare il payload di debug.");
  }
}

function extractUsageStats(response) {
  const usage = response?.usage || {};
  const outputDetails = usage?.output_tokens_details || usage?.output_token_details || {};
  return {
    input_tokens: toFiniteNumber(usage?.input_tokens),
    output_tokens: toFiniteNumber(usage?.output_tokens),
    total_tokens: toFiniteNumber(usage?.total_tokens),
    reasoning_tokens: toFiniteNumber(
      outputDetails?.reasoning_tokens ?? usage?.reasoning_tokens
    )
  };
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.floor(parsed));
}

function redactSensitiveText(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }

  return text
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***REDACTED***")
    .replace(/(api[_\s-]*key[^:\n]*:\s*)([^\s,;]+)/gi, "$1***REDACTED***");
}

function buildLocalFallbackPrompt(userPrompt) {
  const concisePrompt = String(userPrompt || "")
    .replace(/\s+/g, " ")
    .trim();

  const lowerPrompt = concisePrompt.toLowerCase();
  const isHealthRequest = hasAnyKeyword(lowerPrompt, [
    "dieta",
    "alimentazione",
    "dimagr",
    "calorie",
    "fitness",
    "allenamento",
    "nutriz"
  ]);
  const isMarketingRequest = hasAnyKeyword(lowerPrompt, [
    "marketing",
    "campagna",
    "lead",
    "funnel",
    "brand",
    "social",
    "ads",
    "seo",
    "ecommerce",
    "vendit",
    "growth"
  ]);
  const isCodingRequest = hasAnyKeyword(lowerPrompt, [
    "codice",
    "bug",
    "debug",
    "javascript",
    "typescript",
    "python",
    "node",
    "api",
    "app",
    "frontend",
    "backend",
    "deploy",
    "server"
  ]);
  const isStudyRequest = hasAnyKeyword(lowerPrompt, [
    "stud",
    "esame",
    "tesi",
    "impar",
    "apprendere",
    "riassunto",
    "piano studio"
  ]);

  if (isHealthRequest) {
    return [
      "Agisci come nutrizionista educativo (non medico) e personal trainer della nutrizione.",
      "Obiettivo: aiutarmi a iniziare una dieta in modo sano, sostenibile e realistico.",
      "",
      "Richiesta di partenza:",
      concisePrompt,
      "",
      "Prima parte (domande chiarificatrici, max 3):",
      "- Obiettivo principale (dimagrimento, ricomposizione, salute).",
      "- Restrizioni/preferenze alimentari e budget.",
      "- Livello di attivita fisica e routine giornaliera.",
      "",
      "Seconda parte (output pratico):",
      "1. Strategia alimentare semplice per 4 settimane.",
      "2. Calorie/macronutrienti stimate con range (non prescrizione medica).",
      "3. Esempio menu 7 giorni (colazione, pranzo, cena, spuntini).",
      "4. Lista spesa settimanale.",
      "5. Errori da evitare e come gestire fame/sbalzi di motivazione.",
      "6. Piano monitoraggio progressi (peso, circonferenze, energia).",
      "",
      "Vincoli:",
      "- Italiano chiaro, tono pratico.",
      "- Nessuna promessa irrealistica.",
      "- Se emergono segnali clinici, consiglia consulto con dietista/medico."
    ].join("\n");
  }

  if (isMarketingRequest) {
    return [
      "Ruolo: Sei un growth marketer senior orientato ai risultati.",
      "Obiettivo: creare un piano marketing concreto, misurabile e sostenibile.",
      `Richiesta utente: ${concisePrompt}`,
      "Output richiesto:",
      "1. Sintesi strategica in 4-6 righe (target, proposta di valore, canali prioritari).",
      "2. Piano operativo 90 giorni in fasi: setup, test, ottimizzazione, scala.",
      "3. Canali consigliati con motivazione e KPI per ciascun canale.",
      "4. Budget indicativo low/medium/high e ripartizione percentuale.",
      "5. Calendario contenuti/campagne per 4 settimane.",
      "6. Dashboard KPI minima (CAC, CPL, conversion rate, ROAS, LTV) con soglie target.",
      "Vincoli:",
      "- Italiano chiaro, zero teoria superflua.",
      "- Passi numerati e azionabili subito.",
      "- Evidenzia ipotesi da validare."
    ].join("\n");
  }

  if (isCodingRequest) {
    return [
      "Ruolo: Sei un software engineer senior pragmatico.",
      "Obiettivo: fornire una soluzione tecnica implementabile rapidamente.",
      `Richiesta utente: ${concisePrompt}`,
      "Formato output:",
      "1. Diagnosi rapida del problema o obiettivo tecnico.",
      "2. Piano step-by-step con comandi/esempi concreti.",
      "3. Patch di codice proposta (snippets pronti da incollare).",
      "4. Checklist di verifica e test minimi.",
      "Vincoli:",
      "- Evita astrazioni inutili.",
      "- Specifica assunzioni e limiti.",
      "- Mantieni compatibilita con stack web moderno."
    ].join("\n");
  }

  if (isStudyRequest) {
    return [
      "Ruolo: Sei un tutor esperto in metodo di studio.",
      "Obiettivo: costruire un piano di apprendimento realistico e progressivo.",
      `Richiesta utente: ${concisePrompt}`,
      "Formato output:",
      "1. Obiettivo concreto (misurabile) e livello attuale ipotizzato.",
      "2. Piano settimanale con blocchi giornalieri e priorita.",
      "3. Tecniche pratiche (active recall, spaced repetition, esercizi).",
      "4. Metriche di avanzamento e checkpoint.",
      "5. Errori comuni da evitare.",
      "Vincoli:",
      "- Linguaggio semplice e operativo.",
      "- Nessun consiglio generico non applicabile."
    ].join("\n");
  }

  return [
    "Ruolo: Sei un assistente esperto e pragmatico orientato all'azione.",
    "Obiettivo: Fornire una risposta utile, concreta e immediatamente applicabile.",
    `Richiesta utente: ${concisePrompt}`,
    "Vincoli di qualita:",
    "- Linguaggio chiaro e in italiano.",
    "- Soluzione in passi numerati.",
    "- Evidenzia assunzioni e limiti.",
    "- Evita invenzioni non verificabili.",
    "Formato output richiesto:",
    "1. Sintesi in 2-3 righe",
    "2. Piano pratico step-by-step",
    "3. Checklist finale",
    "Domande chiarificatrici (max 3) solo se strettamente necessarie."
  ].join("\n");
}

function hasAnyKeyword(text, keywords) {
  if (!text || !Array.isArray(keywords) || keywords.length === 0) {
    return false;
  }
  return keywords.some((keyword) => text.includes(keyword));
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
  if (USE_CHAT_COMPLETIONS_API) {
    const response = await requestChatCompletionWithTimeoutRetry(
      buildChatCompletionPayload(
        prompt,
        undefined,
        MODEL_NAME,
        getAdaptiveMaxOutputTokens("initial")
      ),
      OPENAI_TIMEOUT_WEB_SEARCH_MS,
      "Provider chat.completions initial"
    );

    return {
      response
    };
  }

  const basePayload = buildBasePayload(
    prompt,
    undefined,
    MODEL_NAME,
    getAdaptiveMaxOutputTokens("initial")
  );
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

function buildChatCompletionPayload(prompt, userInstructionText, modelName, maxOutputTokensOverride) {
  const payload = {
    model: modelName || MODEL_NAME,
    messages: [
      { role: "system", content: SYSTEM_INSTRUCTIONS },
      {
        role: "user",
        content: userInstructionText || `Migliora questo prompt rendendolo specifico e operativo:\n\n${prompt}`
      }
    ]
  };

  const maxOutputTokens = Number.isFinite(maxOutputTokensOverride)
    ? Math.floor(maxOutputTokensOverride)
    : MAX_OUTPUT_TOKENS;

  if (maxOutputTokens > 0) {
    payload.max_tokens = maxOutputTokens;
  }

  return payload;
}

async function requestDirectTextFallback(prompt, isTokenLimited) {
  const retryInstruction = [
    "Genera direttamente il prompt finale ottimizzato in testo semplice.",
    "Nessuna spiegazione extra.",
    isTokenLimited
      ? "Mantieni il risultato molto conciso (massimo 12 righe operative)."
      : "Mantieni il risultato conciso e operativo.",
    "",
    "Prompt di partenza:",
    prompt
  ].join("\n");

  const boostedMaxOutputTokens = getAdaptiveMaxOutputTokens(
    isTokenLimited ? "token_pressure" : "retry"
  );

  if (USE_CHAT_COMPLETIONS_API) {
    return requestChatCompletionWithTimeoutRetry(
      buildChatCompletionPayload(
        prompt,
        retryInstruction,
        MODEL_NAME,
        boostedMaxOutputTokens
      ),
      OPENAI_TIMEOUT_WEB_SEARCH_MS,
      "Provider chat.completions retry-empty-output"
    );
  }

  return requestOpenAIWithTimeoutRetry(
    {
      ...buildBasePayload(prompt, retryInstruction, MODEL_NAME, boostedMaxOutputTokens),
      tools: [{ type: "web_search" }]
    },
    OPENAI_TIMEOUT_WEB_SEARCH_MS,
    "OpenAI+web_search retry-empty-output"
  );
}

async function requestModelOnlyFallback(prompt, isTokenLimited) {
  const retryInstruction = [
    "Genera direttamente il prompt finale ottimizzato in testo semplice.",
    "Nessuna spiegazione extra.",
    "Nessuna chiamata a strumenti esterni.",
    isTokenLimited
      ? "Output compatto: massimo 12 righe operative."
      : "Output conciso e subito applicabile.",
    "",
    "Prompt di partenza:",
    prompt
  ].join("\n");

  const boostedMaxOutputTokens = getAdaptiveMaxOutputTokens(
    isTokenLimited ? "token_pressure" : "retry"
  );

  if (USE_CHAT_COMPLETIONS_API) {
    return requestChatCompletionWithTimeoutRetry(
      buildChatCompletionPayload(
        prompt,
        retryInstruction,
        MODEL_NAME,
        boostedMaxOutputTokens
      ),
      OPENAI_TIMEOUT_WEB_SEARCH_MS,
      "Provider chat.completions model-only retry-empty-output"
    );
  }

  return requestOpenAIWithTimeoutRetry(
    buildBasePayload(prompt, retryInstruction, MODEL_NAME, boostedMaxOutputTokens),
    OPENAI_TIMEOUT_WEB_SEARCH_MS,
    "OpenAI model-only retry-empty-output"
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

async function requestChatCompletion(payload, timeoutMs, label) {
  return withTimeout(openai.chat.completions.create(payload), timeoutMs, label);
}

async function requestFinalizeFromPreviousResponse(previousResponseId, isTokenLimited, prompt) {
  const finalizeInstruction = [
    "Usa i risultati gia raccolti e restituisci ORA solo il prompt finale ottimizzato.",
    "Output testuale puro, nessuna introduzione e nessuna spiegazione.",
    isTokenLimited
      ? "Formato compatto: massimo 12 righe operative."
      : "Mantieni il testo conciso e operativo."
  ].join("\n");

  if (USE_CHAT_COMPLETIONS_API) {
    const finalizePrompt = [
      finalizeInstruction,
      "",
      "Prompt di partenza:",
      prompt
    ].join("\n");

    return requestChatCompletionWithTimeoutRetry(
      buildChatCompletionPayload(
        prompt,
        finalizePrompt,
        MODEL_NAME,
        getAdaptiveMaxOutputTokens(isTokenLimited ? "token_pressure" : "retry")
      ),
      OPENAI_TIMEOUT_WEB_SEARCH_MS,
      "Provider chat.completions finalize-fallback"
    );
  }

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
      max_output_tokens: getAdaptiveMaxOutputTokens(
        isTokenLimited ? "token_pressure" : "retry"
      )
    },
    OPENAI_TIMEOUT_WEB_SEARCH_MS,
    "OpenAI finalize-from-previous"
  );
}

function getAdaptiveMaxOutputTokens(mode) {
  let floor = 1100;
  if (mode === "initial") {
    floor = 1200;
  } else if (mode === "retry") {
    floor = 1600;
  } else if (mode === "token_pressure") {
    floor = 2600;
  }

  if (MAX_OUTPUT_TOKENS > 0) {
    return Math.max(MAX_OUTPUT_TOKENS, floor);
  }
  return floor;
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
  return requestWithTimeoutRetry(requestOpenAI, payload, firstTimeoutMs, label);
}

async function requestChatCompletionWithTimeoutRetry(payload, firstTimeoutMs, label) {
  return requestWithTimeoutRetry(requestChatCompletion, payload, firstTimeoutMs, label);
}

async function requestWithTimeoutRetry(requestFn, payload, firstTimeoutMs, label) {
  let timeoutMs = firstTimeoutMs;
  let lastTimeoutError = null;

  for (let attempt = 0; attempt <= OPENAI_TIMEOUT_RETRIES; attempt += 1) {
    const attemptLabel = attempt === 0 ? label : `${label} retry-${attempt}`;
    try {
      return await requestFn(payload, timeoutMs, attemptLabel);
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
