const el = {
  rawPrompt: document.querySelector('#rawPrompt'),
  audience: document.querySelector('#audience'),
  tone: document.querySelector('#tone'),
  format: document.querySelector('#format'),
  length: document.querySelector('#length'),
  constraints: document.querySelector('#constraints'),
  context: document.querySelector('#context'),
  improvedPrompt: document.querySelector('#improvedPrompt'),
  qualityChecklist: document.querySelector('#qualityChecklist'),
  generateBtn: document.querySelector('#generateBtn'),
  clearBtn: document.querySelector('#clearBtn'),
  copyBtn: document.querySelector('#copyBtn'),
  downloadBtn: document.querySelector('#downloadBtn')
};

const outputFormatGuide = {
  bullet: 'Usa bullet points chiari e sintetici.',
  tabella: 'Presenta l\'output in una tabella con colonne "Sezione", "Dettaglio", "Azione".',
  'step-by-step': 'Organizza la risposta in passaggi numerati, con micro-obiettivi per ogni step.',
  json: 'Restituisci un JSON valido con campi semanticamente chiari.'
};

function buildPrompt() {
  const base = el.rawPrompt.value.trim();
  if (!base) {
    el.improvedPrompt.value = 'Inserisci un prompt iniziale per procedere.';
    renderChecklist([]);
    return;
  }

  const audience = el.audience.value.trim() || 'pubblico generale';
  const tone = el.tone.value;
  const format = el.format.value;
  const length = el.length.value;
  const constraints = el.constraints.value.trim() || 'Nessun vincolo aggiuntivo.';
  const context = el.context.value.trim() || 'Nessun contesto extra fornito.';

  const improved = `Agisci come Prompt Engineer senior specializzato in ChatGPT 5.3.

OBIETTIVO UTENTE:
${base}

CONTESTO:
${context}

PUBBLICO TARGET:
${audience}

REQUISITI DI STILE:
- Tono: ${tone}
- Livello di dettaglio: ${length}
- ${outputFormatGuide[format]}

VINCOLI:
${constraints}

ISTRUZIONI OPERATIVE:
1) Scomponi il problema in sotto-task.
2) Esplicita assunzioni e limiti.
3) Fornisci una risposta orientata all'azione.
4) Includi un mini controllo qualità finale.
5) Se mancano dati, fai massimo 3 domande chiarificatrici prioritarie.

OUTPUT ATTESO:
- Risposta principale nel formato richiesto.
- Sezione "Miglioramenti possibili" con 3 ottimizzazioni concrete.`;

  el.improvedPrompt.value = improved;
  renderChecklist([
    { label: 'Obiettivo esplicito', ok: base.length > 15 },
    { label: 'Contesto presente', ok: context !== 'Nessun contesto extra fornito.' },
    { label: 'Vincoli specificati', ok: constraints !== 'Nessun vincolo aggiuntivo.' },
    { label: 'Formato output definito', ok: Boolean(outputFormatGuide[format]) },
    { label: 'Tono e audience definiti', ok: audience.length > 0 && tone.length > 0 }
  ]);
}

function renderChecklist(items) {
  el.qualityChecklist.innerHTML = '';
  if (!items.length) return;

  items.forEach((item) => {
    const li = document.createElement('li');
    li.className = item.ok ? 'ok' : 'warn';
    li.textContent = `${item.ok ? '✓' : '⚠'} ${item.label}`;
    el.qualityChecklist.appendChild(li);
  });
}

function resetForm() {
  [
    el.rawPrompt,
    el.audience,
    el.constraints,
    el.context,
    el.improvedPrompt
  ].forEach((node) => {
    node.value = '';
  });

  el.tone.value = 'professionale';
  el.format.value = 'bullet';
  el.length.value = 'medio';
  renderChecklist([]);
}

async function copyPrompt() {
  const text = el.improvedPrompt.value.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  el.copyBtn.textContent = 'Copiato!';
  setTimeout(() => {
    el.copyBtn.textContent = 'Copia prompt';
  }, 1200);
}

function downloadPrompt() {
  const text = el.improvedPrompt.value.trim();
  if (!text) return;
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'prompt-ottimizzato-chatgpt53.txt';
  a.click();
  URL.revokeObjectURL(a.href);
}

el.generateBtn.addEventListener('click', buildPrompt);
el.clearBtn.addEventListener('click', resetForm);
el.copyBtn.addEventListener('click', copyPrompt);
el.downloadBtn.addEventListener('click', downloadPrompt);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js');
  });
}
