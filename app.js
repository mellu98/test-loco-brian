"use strict";

const INPUT_STORAGE_KEY = "prompt_forge_single_input_v3";
const DEFAULT_RESULT = "Il prompt ottimizzato apparira qui.";
const BACKEND_TIMEOUT_MS = 160000;
const NETWORK_RETRY_DELAYS_MS = [700, 1500];
const API_BASE = readApiBase();

const form = document.getElementById("prompt-form");
const rawPromptInput = document.getElementById("raw-prompt");
const resultNode = document.getElementById("result");
const statusNode = document.getElementById("status");

const generateBtn = document.getElementById("generate-btn");
const copyBtn = document.getElementById("copy-btn");
const clearBtn = document.getElementById("clear-btn");

copyBtn.addEventListener("click", onCopy);
clearBtn.addEventListener("click", onClear);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await improvePrompt();
});

rawPromptInput.addEventListener("input", () => {
  localStorage.setItem(INPUT_STORAGE_KEY, rawPromptInput.value);
});

restoreDraft();
registerServiceWorker();

async function improvePrompt() {
  const rawPrompt = normalizePrompt(rawPromptInput.value);
  if (!rawPrompt) {
    setStatus("Inserisci un prompt.", true);
    rawPromptInput.focus();
    return;
  }

  setBusy(true);
  setStatus("Ottimizzo con ChatGPT + web research...", false);

  try {
    const result = await improveViaBackend(rawPrompt);
    resultNode.textContent = result.prompt;
    if (result.usedLocalFallback) {
      const debugSuffix = result.debugHint ? ` [${result.debugHint}]` : "";
      setStatus(`Output generato con fallback locale per evitare risposta vuota del modello.${debugSuffix}`, false);
    } else if (result.usedNoWebRecovery) {
      const debugSuffix = result.debugHint ? ` [${result.debugHint}]` : "";
      setStatus(`Output recuperato con tentativo finale del modello primario.${debugSuffix}`, false);
    } else if (result.recoveredFromEmptyOutput) {
      const debugSuffix = result.debugHint ? ` [${result.debugHint}]` : "";
      setStatus(`Il modello ha risposto vuoto al primo tentativo: retry automatico completato.${debugSuffix}`, false);
    } else {
      setStatus("Prompt ottimizzato con web research.", false);
    }
    if (
      result.debug &&
      (result.recoveredFromEmptyOutput || result.usedNoWebRecovery || result.usedLocalFallback)
    ) {
      console.info("Debug modello (/api/improve):", result.debug);
    }
  } catch (error) {
    const fallbackPrompt = buildClientFallbackPrompt(rawPrompt);
    resultNode.textContent = fallbackPrompt;
    const reason = formatBackendErrorForStatus(error);
    setStatus(`Backend non disponibile (${reason}). Output generato in locale.`, false);
    if (error) {
      console.warn("Errore backend /api/improve:", error);
    }
  } finally {
    setBusy(false);
  }
}

async function improveViaBackend(rawPrompt) {
  let lastError = null;

  for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await requestImproveViaBackend(rawPrompt);
    } catch (error) {
      lastError = error;
      if (!isRetryableBackendError(error) || attempt === NETWORK_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await sleep(NETWORK_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError || new Error("Errore sconosciuto durante la richiesta backend.");
}

async function requestImproveViaBackend(rawPrompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  try {
    const endpoint = `${API_BASE}/api/improve`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: rawPrompt }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(await readApiError(response));
    }

    const data = await response.json();
    const output = typeof data?.prompt === "string" ? data.prompt.trim() : "";
    if (!output) {
      throw new Error("Risposta vuota dal server.");
    }
    return {
      prompt: output,
      recoveredFromEmptyOutput: Boolean(data?.recoveredFromEmptyOutput),
      usedLocalFallback: Boolean(data?.usedLocalFallback),
      usedNoWebRecovery: Boolean(data?.usedNoWebRecovery),
      requestId: typeof data?.requestId === "string" ? data.requestId : "",
      debug: data?.debug && typeof data.debug === "object" ? data.debug : null,
      debugHint: formatFallbackDebugHint(data?.debug)
    };
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("Timeout: il server ha impiegato troppo tempo a rispondere.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isRetryableBackendError(error) {
  if (!error) {
    return false;
  }

  const message = String(error.message || "").toLowerCase();
  if (message.startsWith("timeout:")) {
    return true;
  }

  return isNetworkFailureMessage(message);
}

function formatBackendErrorForStatus(error) {
  const raw = error && typeof error.message === "string" ? error.message.trim() : "";
  const message = raw || "errore sconosciuto";
  const lower = message.toLowerCase();

  if (isNetworkFailureMessage(lower)) {
    if (navigator.onLine === false) {
      return "connessione assente (offline)";
    }
    return "connessione al server fallita";
  }

  if (lower.startsWith("timeout:")) {
    return "timeout del backend";
  }

  return message;
}

function isNetworkFailureMessage(message) {
  return (
    message.includes("load failed") ||
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network error")
  );
}

function readApiBase() {
  const meta = document.querySelector('meta[name="prompt-api-base"]');
  const value = meta && typeof meta.content === "string" ? meta.content.trim() : "";
  if (!value) {
    return "";
  }
  return value.replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFallbackDebugHint(debug) {
  if (!debug || typeof debug !== "object") {
    return "";
  }

  const diagnosis = debug?.diagnosis && typeof debug.diagnosis === "object"
    ? debug.diagnosis
    : null;
  const primary = debug?.first_attempt && typeof debug.first_attempt === "object"
    ? debug.first_attempt
    : debug;
  const errorPart = debug?.error && typeof debug.error === "object"
    ? debug.error
    : debug;

  const parts = [];
  if (typeof debug.request_id === "string" && debug.request_id) {
    parts.push(`id=${debug.request_id.slice(0, 8)}`);
  }
  if (typeof diagnosis?.root_cause === "string" && diagnosis.root_cause) {
    parts.push(`cause=${diagnosis.root_cause}`);
  }
  if (typeof primary.status === "string" && primary.status) {
    parts.push(`status=${primary.status}`);
  }
  if (typeof primary.incomplete_reason === "string" && primary.incomplete_reason) {
    parts.push(`reason=${primary.incomplete_reason}`);
  }
  if (Array.isArray(primary.output_types) && primary.output_types.length > 0) {
    parts.push(`types=${primary.output_types.join(",")}`);
  }
  if (typeof primary.elapsed_ms === "number" && Number.isFinite(primary.elapsed_ms)) {
    parts.push(`first_ms=${primary.elapsed_ms}`);
  }
  if (typeof primary.usage_total_tokens === "number" && Number.isFinite(primary.usage_total_tokens)) {
    parts.push(`tok=${primary.usage_total_tokens}`);
  }
  if (typeof errorPart.timeout_label === "string" && errorPart.timeout_label) {
    parts.push(`timeout=${errorPart.timeout_label}`);
  }
  if (typeof errorPart.timeout_ms === "number" && Number.isFinite(errorPart.timeout_ms)) {
    parts.push(`ms=${errorPart.timeout_ms}`);
  }
  if (typeof errorPart.attempts === "number" && Number.isFinite(errorPart.attempts)) {
    parts.push(`attempts=${errorPart.attempts}`);
  }
  if (typeof errorPart.upstream_status === "number" && Number.isFinite(errorPart.upstream_status)) {
    parts.push(`upstream_status=${errorPart.upstream_status}`);
  }
  if (typeof errorPart.upstream_error === "string" && errorPart.upstream_error.trim()) {
    parts.push(`upstream_error=${errorPart.upstream_error.trim().slice(0, 120)}`);
  }

  return parts.slice(0, 7).join(" | ");
}

async function readApiError(response) {
  if (response.status === 405) {
    return "HTTP 405: endpoint non configurato per POST. Probabile deploy come sito statico invece di Web Service Node.";
  }

  try {
    const rawBody = await response.text();
    let payload = null;
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody);
      } catch (_parseError) {
        payload = null;
      }
    }

    const message = payload?.error || payload?.message;
    if (typeof message === "string" && message.trim()) {
      if (payload?.debug && typeof payload.debug === "object") {
        return `${message} [debug: ${JSON.stringify(payload.debug)}]`;
      }
      return message;
    }

    const compactBody = String(rawBody || "").replace(/\s+/g, " ").trim();
    if (compactBody) {
      return `HTTP ${response.status}: ${compactBody.slice(0, 220)}`;
    }

    return `HTTP ${response.status}`;
  } catch (_error) {
    return `HTTP ${response.status}`;
  }
}

async function onCopy() {
  const text = resultNode.textContent.trim();
  if (!text || text === DEFAULT_RESULT) {
    setStatus("Nessun risultato da copiare.", true);
    return;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(resultNode);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("copy");
      selection.removeAllRanges();
    }
    setStatus("Risultato copiato.", false);
  } catch (_error) {
    setStatus("Copia non riuscita.", true);
  }
}

function onClear() {
  rawPromptInput.value = "";
  resultNode.textContent = DEFAULT_RESULT;
  localStorage.removeItem(INPUT_STORAGE_KEY);
  setStatus("Pulito.", false);
}

function restoreDraft() {
  const draft = localStorage.getItem(INPUT_STORAGE_KEY);
  if (!draft) {
    return;
  }
  rawPromptInput.value = draft;
  setStatus("Bozza ripristinata.", false);
}

function normalizePrompt(value) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildClientFallbackPrompt(userPrompt) {
  const concisePrompt = String(userPrompt || "").replace(/\s+/g, " ").trim();
  const lower = concisePrompt.toLowerCase();

  if (hasAnyKeyword(lower, ["marketing", "brand", "ads", "social", "seo", "vendit", "funnel", "lead"])) {
    return [
      "Ruolo: Sei un growth marketer senior orientato ai risultati.",
      "Obiettivo: costruire un piano marketing pratico e misurabile.",
      `Richiesta utente: ${concisePrompt}`,
      "Output richiesto:",
      "1. Strategia sintetica (target, proposta di valore, canali prioritari).",
      "2. Piano operativo 30/60/90 giorni con attivita settimanali.",
      "3. KPI principali e soglie target.",
      "4. Budget indicativo e priorita di investimento.",
      "5. Rischi principali e contromisure."
    ].join("\n");
  }

  if (hasAnyKeyword(lower, ["dieta", "alimentazione", "fitness", "allenamento", "calorie", "nutriz"])) {
    return [
      "Ruolo: Sei un coach alimentare educativo (non medico).",
      "Obiettivo: proporre un piano dieta sostenibile e realistico.",
      `Richiesta utente: ${concisePrompt}`,
      "Output richiesto:",
      "1. Piano pratico per 4 settimane.",
      "2. Esempio menu settimanale semplice.",
      "3. Lista spesa base.",
      "4. Indicatori di monitoraggio progressi.",
      "5. Avvertenza: per condizioni cliniche, consultare professionista."
    ].join("\n");
  }

  if (hasAnyKeyword(lower, ["bug", "codice", "javascript", "python", "api", "server", "deploy"])) {
    return [
      "Ruolo: Sei un software engineer senior pragmatico.",
      "Obiettivo: risolvere il problema tecnico in modo implementabile.",
      `Richiesta utente: ${concisePrompt}`,
      "Output richiesto:",
      "1. Diagnosi rapida.",
      "2. Piano step-by-step con comandi concreti.",
      "3. Patch proposta.",
      "4. Test di verifica."
    ].join("\n");
  }

  return [
    "Ruolo: Sei un assistente esperto e pragmatico.",
    "Obiettivo: fornire una risposta chiara, utile e subito applicabile.",
    `Richiesta utente: ${concisePrompt}`,
    "Formato output:",
    "1. Sintesi breve",
    "2. Piano pratico a passi numerati",
    "3. Checklist finale"
  ].join("\n");
}

function hasAnyKeyword(text, keywords) {
  if (!text || !Array.isArray(keywords) || keywords.length === 0) {
    return false;
  }
  return keywords.some((keyword) => text.includes(keyword));
}

function setStatus(message, isError) {
  statusNode.textContent = message;
  statusNode.classList.toggle("status-error", isError);
  statusNode.classList.toggle("status-ok", !isError);
}

function setBusy(isBusy) {
  [generateBtn, copyBtn, clearBtn].forEach((control) => {
    if (!control) {
      return;
    }
    control.disabled = isBusy;
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/service-worker.js")
      .catch((error) => {
        console.warn("Service Worker non registrato:", error);
      });
  });
}
