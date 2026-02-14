"use strict";

const INPUT_STORAGE_KEY = "prompt_forge_single_input_v3";
const WEB_SEARCH_STORAGE_KEY = "prompt_forge_use_web_search_v1";
const DEFAULT_RESULT = "Il prompt ottimizzato apparira qui.";
const BACKEND_TIMEOUT_MS = 32000;

const form = document.getElementById("prompt-form");
const rawPromptInput = document.getElementById("raw-prompt");
const resultNode = document.getElementById("result");
const statusNode = document.getElementById("status");

const generateBtn = document.getElementById("generate-btn");
const copyBtn = document.getElementById("copy-btn");
const clearBtn = document.getElementById("clear-btn");
const useWebSearchInput = document.getElementById("use-web-search");

copyBtn.addEventListener("click", onCopy);
clearBtn.addEventListener("click", onClear);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await improvePrompt();
});

rawPromptInput.addEventListener("input", () => {
  localStorage.setItem(INPUT_STORAGE_KEY, rawPromptInput.value);
});

if (useWebSearchInput) {
  useWebSearchInput.addEventListener("change", () => {
    localStorage.setItem(WEB_SEARCH_STORAGE_KEY, useWebSearchInput.checked ? "1" : "0");
  });
}

restoreDraft();
restoreWebSearchPreference();
registerServiceWorker();

async function improvePrompt() {
  const rawPrompt = normalizePrompt(rawPromptInput.value);
  const requestedWebSearch = Boolean(useWebSearchInput?.checked);
  if (!rawPrompt) {
    setStatus("Inserisci un prompt.", true);
    rawPromptInput.focus();
    return;
  }

  setBusy(true);
  setStatus(
    requestedWebSearch
      ? "Ottimizzo con ChatGPT + web research..."
      : "Ottimizzo con ChatGPT (modalita veloce)...",
    false
  );

  try {
    const result = await improveViaBackend(rawPrompt, requestedWebSearch);
    resultNode.textContent = result.prompt;
    if (result.fallbackToNoWebSearch) {
      setStatus("Web research lenta/non disponibile: completato senza ricerca web.", false);
    } else if (result.usedWebSearch) {
      setStatus("Prompt ottimizzato con web research.", false);
    } else {
      setStatus("Prompt ottimizzato (modalita veloce).", false);
    }
  } catch (error) {
    setStatus(`Errore: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function improveViaBackend(rawPrompt, useWebSearch) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  let response;

  try {
    response = await fetch("/api/improve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: rawPrompt, useWebSearch }),
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("Timeout: il server ha impiegato troppo tempo a rispondere.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

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
    usedWebSearch: Boolean(data?.usedWebSearch),
    fallbackToNoWebSearch: Boolean(data?.fallbackToNoWebSearch)
  };
}

async function readApiError(response) {
  if (response.status === 405) {
    return "HTTP 405: endpoint non configurato per POST. Probabile deploy come sito statico invece di Web Service Node.";
  }

  try {
    const payload = await response.json();
    const message = payload?.error || payload?.message;
    if (typeof message === "string" && message.trim()) {
      return message;
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

function restoreWebSearchPreference() {
  if (!useWebSearchInput) {
    return;
  }

  const savedValue = localStorage.getItem(WEB_SEARCH_STORAGE_KEY);
  if (savedValue === "1") {
    useWebSearchInput.checked = true;
  }
}

function normalizePrompt(value) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function setStatus(message, isError) {
  statusNode.textContent = message;
  statusNode.classList.toggle("status-error", isError);
  statusNode.classList.toggle("status-ok", !isError);
}

function setBusy(isBusy) {
  [generateBtn, copyBtn, clearBtn, useWebSearchInput].forEach((control) => {
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
