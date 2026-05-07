// ─── STATE ────────────────────────────────────────────────────────────────
const session = {
  extraction: null,
  questions: [],
  answers: {},
  scopingDoc: '',
  architecture: null,
  generatedPrompts: [],
  trackerHtml: '',
  promptQueue: []
};

let currentStage = 1;
let currentPromptIndex = 0;
let streamAccumulator = '';

// ─── UTILS ────────────────────────────────────────────────────────────────

async function api(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Request failed');
  return data;
}

async function streamApi(url, body, onChunk, onDone, onError) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.error) { onError(new Error(data.error)); return; }
        if (data.done) { onDone(); return; }
        if (data.text) onChunk(data.text);
      } catch {}
    }
  }
}

function setStage(n) {
  document.querySelectorAll('.stage-panel').forEach(el => el.classList.remove('active'));
  document.getElementById(`stage-${n}`).classList.add('active');

  document.querySelectorAll('.stage-nav-item').forEach(el => {
    const s = parseInt(el.dataset.stage);
    el.classList.remove('active', 'done');
    if (s === n) el.classList.add('active');
    else if (s < n) el.classList.add('done');
  });

  // Top progress bar
  const total = 7;
  const pct = ((n - 1) / (total - 1)) * 100;
  const fill = document.getElementById('top-progress-fill');
  if (fill) fill.style.width = `${pct}%`;

  document.querySelectorAll('.tps-item').forEach(el => {
    const s = parseInt(el.dataset.stage);
    el.classList.remove('active', 'done');
    if (s === n) el.classList.add('active');
    else if (s < n) el.classList.add('done');
  });

  currentStage = n;
  window.scrollTo(0, 0);
  document.querySelector('.main').scrollTo(0, 0);
}

function markNavDone(n) {
  const el = document.getElementById(`nav-status-${n}`);
  if (el) el.textContent = '';
}

function showError(stageNum, msg) {
  const el = document.getElementById(`stage${stageNum}-error`);
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function hideError(stageNum) {
  const el = document.getElementById(`stage${stageNum}-error`);
  if (el) el.style.display = 'none';
}

function setLoading(btn, text) {
  btn.disabled = true;
  btn._originalHTML = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span>${text}`;
}

function clearLoading(btn) {
  btn.disabled = false;
  if (btn._originalHTML) btn.innerHTML = btn._originalHTML;
}

// ─── STAGE 1: INPUT ────────────────────────────────────────────────────────

document.getElementById('file-upload').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    document.getElementById('input-text').value = ev.target.result;
    document.getElementById('file-name').textContent = file.name;
  };
  reader.readAsText(file);
});

document.getElementById('analyse-btn').addEventListener('click', async () => {
  const input = document.getElementById('input-text').value.trim();
  if (!input) { showError(1, 'Please paste some input text before analysing.'); return; }
  hideError(1);

  const btn = document.getElementById('analyse-btn');
  setLoading(btn, 'Analysing...');

  try {
    const result = await api('/api/extract', { input });
    session.extraction = result.data;
    setStage(2);
    renderExtraction();
  } catch (err) {
    showError(1, `Analysis failed: ${err.message}`);
  } finally {
    clearLoading(btn);
  }
});

// ─── STAGE 2: ANALYSIS ────────────────────────────────────────────────────

function renderExtraction() {
  const { extraction } = session;
  const container = document.getElementById('extraction-display');

  const useCaseTags = (extraction.useCases || []).map(u => `<span class="tag">${esc(u)}</span>`).join('');
  const docTags = (extraction.documentTypes || []).map(d => `<span class="tag">${esc(d)}</span>`).join('') || '<span class="tag warning">None detected</span>';
  const constraintTags = (extraction.constraints || []).map(c => `<span class="tag warning">${esc(c)}</span>`).join('') || '—';
  const outputTags = (extraction.outputPrefs || []).map(o => `<span class="tag">${esc(o)}</span>`).join('') || '—';
  const ambiguityTags = (extraction.ambiguities || []).map(a => `<span class="tag warning">${esc(a)}</span>`).join('') || '<span style="color:var(--green);font-size:13px">None — input was clear</span>';

  const stakeholders = (extraction.stakeholders || []).length
    ? extraction.stakeholders.map(s =>
        `<div class="stakeholder-item"><span class="stakeholder-name">${esc(s.name || s)}</span>${s.role ? `<span class="stakeholder-role">· ${esc(s.role)}</span>` : ''}</div>`
      ).join('')
    : '<span style="color:var(--text-light);font-size:13px">None identified</span>';

  const complexity = extraction.complexityScore || 'medium';
  const archHint = extraction.architectureHint || 'unclear';

  container.innerHTML = `
    <div style="margin-bottom:16px">
      <div style="font-size:13.5px;color:var(--text-muted);margin-bottom:4px">Client / Project</div>
      <div style="font-size:16px;font-weight:600;color:var(--accent)">${esc(extraction.clientName || 'Unknown')}${extraction.projectName ? ` — <span style="font-weight:400">${esc(extraction.projectName)}</span>` : ''}</div>
    </div>

    <div class="extraction-grid">
      <div class="extraction-card">
        <div class="extraction-card-title">Use Cases (${(extraction.useCases || []).length})</div>
        <div class="tag-list">${useCaseTags || '<span style="color:var(--red);font-size:13px">None detected — check input</span>'}</div>
      </div>

      <div class="extraction-card">
        <div class="extraction-card-title">Stakeholders</div>
        <div class="stakeholder-list">${stakeholders}</div>
      </div>

      <div class="extraction-card">
        <div class="extraction-card-title">Input Document Types</div>
        <div class="tag-list">${docTags}</div>
      </div>

      <div class="extraction-card">
        <div class="extraction-card-title">Output Preferences</div>
        <div class="tag-list">${outputTags}</div>
      </div>

      <div class="extraction-card full-width">
        <div class="extraction-card-title">Constraints Detected</div>
        <div class="tag-list">${constraintTags}</div>
      </div>

      <div class="extraction-card full-width">
        <div class="extraction-card-title">Ambiguities (to clarify)</div>
        <div class="tag-list">${ambiguityTags}</div>
      </div>

      <div class="extraction-card">
        <div class="extraction-card-title">Complexity</div>
        <span class="complexity-badge ${complexity}">${complexity.charAt(0).toUpperCase() + complexity.slice(1)}</span>
      </div>

      <div class="extraction-card">
        <div class="extraction-card-title">Architecture Hint</div>
        <span class="tag">${archHint}</span>
      </div>
    </div>
  `;
}

document.getElementById('confirm-extraction-btn').addEventListener('click', async () => {
  hideError(2);
  const btn = document.getElementById('confirm-extraction-btn');
  setLoading(btn, 'Generating questions...');

  try {
    const result = await api('/api/questions', { extraction: session.extraction });
    session.questions = result.questions;
    setStage(3);
    renderQuestions();
  } catch (err) {
    showError(2, `Failed to generate questions: ${err.message}`);
  } finally {
    clearLoading(btn);
  }
});

// ─── STAGE 3: CLARIFY ─────────────────────────────────────────────────────

function renderQuestions() {
  const form = document.getElementById('questions-form');
  form.innerHTML = session.questions.map(q => {
    const requiredMark = q.required ? '<span style="color:var(--red)">*</span>' : '';

    let input = '';
    if (q.type === 'select' && q.options?.length) {
      input = `<select class="question-select" name="${q.id}" id="q-${q.id}">
        <option value="">— Select —</option>
        ${q.options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
      </select>`;
    } else if (q.type === 'multiselect' && q.options?.length) {
      input = `<div class="question-checkboxes">
        ${q.options.map(o => `
          <label>
            <input type="checkbox" name="${q.id}" value="${esc(o)}">
            ${esc(o)}
          </label>`).join('')}
      </div>`;
    } else {
      input = `<input type="text" class="question-input" name="${q.id}" id="q-${q.id}" placeholder="Your answer...">`;
    }

    return `
      <div class="question-item">
        <div class="question-label">${esc(q.question)} ${requiredMark}</div>
        ${q.hint ? `<div class="question-hint">${esc(q.hint)}</div>` : ''}
        ${input}
      </div>
    `;
  }).join('');
}

document.getElementById('submit-answers-btn').addEventListener('click', async () => {
  hideError(3);

  // Collect answers
  session.answers = {};
  for (const q of session.questions) {
    if (q.type === 'multiselect') {
      const checked = Array.from(document.querySelectorAll(`input[name="${q.id}"]:checked`)).map(el => el.value);
      session.answers[q.id] = checked.join(', ');
    } else if (q.type === 'select') {
      session.answers[q.id] = document.querySelector(`select[name="${q.id}"]`)?.value || '';
    } else {
      session.answers[q.id] = document.getElementById(`q-${q.id}`)?.value?.trim() || '';
    }
  }

  // Check required
  const missing = session.questions.filter(q => q.required && !session.answers[q.id]);
  if (missing.length) {
    showError(3, `Please answer all required questions (${missing.length} remaining).`);
    return;
  }

  setStage(4);
  generateScope();
});

// ─── STAGE 4: SCOPE ────────────────────────────────────────────────────────

async function generateScope() {
  const preview = document.getElementById('scope-preview');
  const badge = document.getElementById('scope-generating-badge');
  const approveBtn = document.getElementById('approve-scope-btn');

  preview.innerHTML = '<div class="loading-row"><span class="spinner"></span>Generating scoping document...</div>';
  streamAccumulator = '';
  approveBtn.disabled = true;
  badge.textContent = 'Generating...';
  badge.classList.remove('done');
  badge.style.display = 'inline-block';

  try {
    await streamApi(
      '/api/scope',
      { extraction: session.extraction, questions: session.questions, answers: session.answers },
      (chunk) => {
        streamAccumulator += chunk;
        preview.innerHTML = marked.parse(streamAccumulator);
        preview.scrollTop = preview.scrollHeight;
      },
      () => {
        session.scopingDoc = streamAccumulator;
        document.getElementById('scope-editor').value = streamAccumulator;
        badge.textContent = 'Complete';
        badge.classList.add('done');
        approveBtn.disabled = false;
      },
      (err) => {
        preview.innerHTML = `<div class="error-msg">Generation failed: ${esc(err.message)}</div>`;
      }
    );
  } catch (err) {
    preview.innerHTML = `<div class="error-msg">Generation failed: ${esc(err.message)}</div>`;
  }
}

function switchScopeTab(tab) {
  const preview = document.getElementById('scope-preview');
  const editor = document.getElementById('scope-editor');
  const tabPreview = document.getElementById('tab-preview');
  const tabEdit = document.getElementById('tab-edit');

  if (tab === 'preview') {
    preview.style.display = 'block';
    editor.style.display = 'none';
    tabPreview.classList.add('active');
    tabEdit.classList.remove('active');
    // Sync from editor if edited
    if (editor.value !== session.scopingDoc) {
      session.scopingDoc = editor.value;
      preview.innerHTML = marked.parse(session.scopingDoc);
    }
  } else {
    preview.style.display = 'none';
    editor.style.display = 'block';
    tabPreview.classList.remove('active');
    tabEdit.classList.add('active');
    editor.value = session.scopingDoc;
  }
}

document.getElementById('approve-scope-btn').addEventListener('click', async () => {
  // Capture any edits from the editor tab
  const editor = document.getElementById('scope-editor');
  if (editor.style.display !== 'none') {
    session.scopingDoc = editor.value;
  }

  const btn = document.getElementById('approve-scope-btn');
  setLoading(btn, 'Getting architecture recommendation...');

  try {
    const result = await api('/api/architecture', {
      extraction: session.extraction,
      answers: session.answers,
      questions: session.questions
    });
    session.architecture = result.architecture;
    setStage(5);
    renderArchitecture();
  } catch (err) {
    showError(4, `Failed to get architecture recommendation: ${err.message}`);
  } finally {
    clearLoading(btn);
  }
});

// ─── STAGE 5: ARCHITECTURE ────────────────────────────────────────────────

function renderArchitecture() {
  const { architecture } = session;
  const container = document.getElementById('architecture-display');
  const prefix = architecture.filePrefix || 'client';
  const isModular = architecture.recommendation === 'modular';

  const files = isModular
    ? [
        { name: `${prefix}-copilot-instructions-v1.0.md`, type: 'Copilot Instructions', cls: 'copilot' },
        ...(architecture.promptNames || []).map(n => ({
          name: `${prefix}-${n.toLowerCase().replace(/\s+/g, '-')}-v1.0.md`,
          type: 'Azure Prompt',
          cls: 'azure'
        }))
      ]
    : [{ name: `${prefix}-copilot-instructions-v1.0.md`, type: 'Copilot Instructions', cls: 'copilot' }];

  const warnings = (architecture.warnings || []).map(w =>
    `<div class="arch-warning">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 1L1 14h14L8 1z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v4M8 11.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      ${esc(w)}
    </div>`
  ).join('');

  container.innerHTML = `
    <div class="arch-recommendation ${architecture.recommendation}">
      ${isModular
        ? '<svg width="18" height="18" viewBox="0 0 16 16" fill="none"><rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="10" y="1" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="1" y="10" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/><rect x="10" y="10" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.5"/></svg>'
        : '<svg width="18" height="18" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/></svg>'}
      ${isModular ? 'Modular Architecture' : 'Monolithic Architecture'} — ${architecture.promptCount} file${architecture.promptCount > 1 ? 's' : ''}
    </div>

    <div class="arch-rationale">${esc(architecture.rationale)}</div>

    ${warnings}

    <div class="arch-files">
      <div class="arch-files-header">Files to be generated</div>
      ${files.map(f => `
        <div class="arch-file-item">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.5"/><path d="M10 2v4h4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
          <span class="arch-file-name">${esc(f.name)}</span>
          <span class="arch-file-type ${f.cls}">${esc(f.type)}</span>
        </div>
      `).join('')}
    </div>

    <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:14px 18px;font-size:12.5px;color:var(--text-muted);">
      <strong style="color:var(--text)">Naming convention:</strong> <code style="font-family:var(--mono);font-size:11.5px">${esc(architecture.fileNamingConvention || `${prefix}-[function]-v1.0.md`)}</code>
    </div>
  `;

  // Store the file list for generation
  session.promptQueue = files;
}

document.getElementById('approve-arch-btn').addEventListener('click', () => {
  setStage(6);
  currentPromptIndex = 0;
  generateCurrentPrompt();
});

// ─── STAGE 6: GENERATE ────────────────────────────────────────────────────

function buildPromptMeta(file, index) {
  const isCopilot = file.type === 'Copilot Instructions';
  return {
    promptType: isCopilot ? 'copilot-instructions' : 'azure-prompt',
    promptName: isCopilot ? null : file.name.replace(`${session.architecture.filePrefix}-`, '').replace('-v1.0.md', ''),
    filename: file.name,
    description: isCopilot
      ? 'Copilot Studio routing and orchestration layer'
      : `Azure Prompt: ${file.name}`,
    isCopilot
  };
}

async function generateCurrentPrompt() {
  const file = session.promptQueue[currentPromptIndex];
  const meta = buildPromptMeta(file, currentPromptIndex);
  const total = session.promptQueue.length;

  // Update header
  document.getElementById('generate-title').textContent = meta.isCopilot
    ? 'Copilot Instructions'
    : `Azure Prompt — ${meta.promptName}`;
  document.getElementById('generate-progress').textContent =
    `${currentPromptIndex + 1} of ${total}`;
  document.getElementById('generate-subtitle').textContent = meta.isCopilot
    ? 'The routing and orchestration layer for Copilot Studio. Hard limit: 8,000 characters.'
    : `Standalone Azure Prompt Library prompt for: ${meta.promptName}`;

  // Toolbar
  document.getElementById('generate-filename').textContent = file.name;
  const charCounter = document.getElementById('char-counter');
  charCounter.style.display = meta.isCopilot ? 'inline-block' : 'none';
  if (meta.isCopilot) updateCharCounter('');

  // Reset view
  const preview = document.getElementById('prompt-preview');
  const editor = document.getElementById('prompt-editor');
  const tabs = document.getElementById('generate-tabs');
  const approveBtn = document.getElementById('approve-prompt-btn');

  preview.style.display = 'block';
  editor.style.display = 'none';
  tabs.style.display = 'none';
  preview.innerHTML = '<div class="loading-row"><span class="spinner"></span>Generating prompt...</div>';
  approveBtn.disabled = true;
  streamAccumulator = '';

  // Update approve button label
  const isLast = currentPromptIndex === total - 1;
  approveBtn.innerHTML = isLast
    ? `Approve & Build Package <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8l4 4 8-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `Approve & Generate Next <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  try {
    await streamApi(
      '/api/generate',
      {
        session: {
          extraction: session.extraction,
          architecture: session.architecture,
          scopingDoc: session.scopingDoc,
          questions: session.questions,
          answers: session.answers
        },
        promptType: meta.promptType,
        promptName: meta.promptName,
        promptIndex: currentPromptIndex
      },
      (chunk) => {
        streamAccumulator += chunk;
        preview.innerHTML = marked.parse(streamAccumulator);
        preview.scrollTop = preview.scrollHeight;
        if (meta.isCopilot) updateCharCounter(streamAccumulator);
      },
      () => {
        editor.value = streamAccumulator;
        tabs.style.display = 'flex';
        approveBtn.disabled = false;
        document.getElementById('feedback-section').style.display = 'block';
      },
      (err) => {
        preview.innerHTML = `<div class="error-msg">Generation failed: ${esc(err.message)}</div>`;
      }
    );
  } catch (err) {
    preview.innerHTML = `<div class="error-msg">Generation failed: ${esc(err.message)}</div>`;
  }
}

function updateCharCounter(text) {
  const count = text.length;
  const el = document.getElementById('char-counter');
  el.textContent = `${count.toLocaleString()} / 8,000 chars`;
  el.className = 'char-counter';
  if (count > 8000) el.classList.add('over');
  else if (count > 7500) el.classList.add('warn');
  else el.classList.add('ok');
}

function switchPromptTab(tab) {
  const preview = document.getElementById('prompt-preview');
  const editor = document.getElementById('prompt-editor');
  const tabPreview = document.getElementById('gtab-preview');
  const tabEdit = document.getElementById('gtab-edit');

  if (tab === 'preview') {
    if (editor.style.display !== 'none') {
      streamAccumulator = editor.value;
      preview.innerHTML = marked.parse(streamAccumulator);
      if (document.getElementById('char-counter').style.display !== 'none') {
        updateCharCounter(streamAccumulator);
      }
    }
    preview.style.display = 'block';
    editor.style.display = 'none';
    tabPreview.classList.add('active');
    tabEdit.classList.remove('active');
  } else {
    preview.style.display = 'none';
    editor.style.display = 'block';
    editor.value = streamAccumulator;
    tabPreview.classList.remove('active');
    tabEdit.classList.add('active');
  }
}

document.getElementById('approve-prompt-btn').addEventListener('click', async () => {
  // Capture any edits
  const editor = document.getElementById('prompt-editor');
  if (editor.style.display !== 'none') {
    streamAccumulator = editor.value;
  }

  const file = session.promptQueue[currentPromptIndex];
  const meta = buildPromptMeta(file, currentPromptIndex);

  session.generatedPrompts.push({
    filename: file.name,
    content: streamAccumulator,
    type: meta.isCopilot ? 'Copilot Instructions' : 'Azure Prompt',
    description: meta.description
  });

  currentPromptIndex++;

  // Hide feedback section before moving on
  document.getElementById('feedback-section').style.display = 'none';
  document.getElementById('feedback-form').style.display = 'none';
  document.getElementById('feedback-chevron').textContent = '+';

  if (currentPromptIndex < session.promptQueue.length) {
    generateCurrentPrompt();
  } else {
    setStage(7);
    buildPackageStage();
  }
});

// ─── STAGE 7: PACKAGE ─────────────────────────────────────────────────────

async function buildPackageStage() {
  const container = document.getElementById('package-display');
  const prefix = session.architecture?.filePrefix || 'client';

  // Show summary while tracker generates
  const allFiles = [
    { name: `${prefix}-scoping-v1.0.md`, type: 'Scoping Document' },
    ...session.generatedPrompts.map(p => ({ name: p.filename, type: p.type })),
    { name: `${prefix}-change-tracker-v1.0.html`, type: 'Change Tracker' },
    { name: 'MANIFEST.md', type: 'Manifest' }
  ];

  container.innerHTML = `
    <div class="package-summary">
      <div class="package-summary-title">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="display:inline;vertical-align:middle;margin-right:6px"><path d="M2 8l4 4 8-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        All artefacts generated — ${allFiles.length} files
      </div>
      <div class="package-file-list">
        ${allFiles.map(f => `
          <div class="package-file">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 2h7l3 3v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" stroke-width="1.5"/><path d="M10 2v4h4" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
            <span class="package-file-name">${esc(f.name)}</span>
            <span class="package-file-type">${esc(f.type)}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="tracker-preview" id="tracker-preview-wrapper">
      <div class="tracker-preview-header">Change Tracker Preview</div>
      <div style="padding:24px;text-align:center" id="tracker-loading">
        <div class="loading-row" style="justify-content:center">
          <span class="spinner"></span> Generating change tracker...
        </div>
      </div>
    </div>
  `;

  try {
    const result = await api('/api/tracker', { session });
    session.trackerHtml = result.html;

    const wrapper = document.getElementById('tracker-preview-wrapper');
    wrapper.innerHTML = `
      <div class="tracker-preview-header">Change Tracker Preview</div>
      <iframe id="tracker-iframe" srcdoc="${esc(session.trackerHtml, true)}" title="Change Tracker Preview"></iframe>
    `;
  } catch (err) {
    document.getElementById('tracker-loading').innerHTML =
      `<div class="error-msg">Failed to generate change tracker: ${esc(err.message)}</div>`;
  }
}

document.getElementById('download-btn').addEventListener('click', async () => {
  const btn = document.getElementById('download-btn');
  setLoading(btn, 'Preparing download...');

  try {
    const res = await fetch('/api/package', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session })
    });

    if (!res.ok) throw new Error('Package generation failed');

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const prefix = (session.extraction?.clientName || 'client').toLowerCase().replace(/\s+/g, '-');
    a.href = url;
    a.download = `${prefix}-deployment-package.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    await saveSession(7);
    showToast('Package downloaded · Session saved');
  } catch (err) {
    alert(`Download failed: ${err.message}`);
  } finally {
    clearLoading(btn);
  }
});

document.getElementById('new-session-btn').addEventListener('click', resetSession);
document.getElementById('reset-btn').addEventListener('click', () => {
  if (currentStage > 1 && !confirm('Start a new session? All current progress will be lost.')) return;
  resetSession();
});

// ─── SESSIONS ─────────────────────────────────────────────────────────────

document.getElementById('open-sessions-btn').addEventListener('click', openSessionsModal);

async function openSessionsModal() {
  document.getElementById('sessions-modal').style.display = 'flex';
  const list = document.getElementById('sessions-list');
  list.innerHTML = '<div class="loading-row"><span class="spinner"></span>Loading...</div>';

  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();

    if (!data.sessions.length) {
      list.innerHTML = '<div class="modal-empty">No saved sessions yet. Sessions are saved automatically when you download a package.</div>';
      return;
    }

    list.innerHTML = data.sessions.map(s => {
      const date = new Date(s.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      const time = new Date(s.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      const stageLabels = ['','Input','Analysis','Clarify','Scope','Architecture','Generate','Package'];
      return `
        <div class="session-card" id="session-${s.id}">
          <div class="session-card-main">
            <div class="session-client">${esc(s.clientName)}${s.projectName ? ` <span class="session-project">· ${esc(s.projectName)}</span>` : ''}</div>
            <div class="session-meta">${date} at ${time} · Stage ${s.stage}: ${stageLabels[s.stage] || ''}</div>
          </div>
          <div class="session-card-actions">
            <button class="btn-session-load" onclick="loadSession('${s.id}')">Load</button>
            <button class="btn-session-delete" onclick="deleteSession('${s.id}')">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V2h4v2M5 4v9h6V4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>`;
    }).join('');

    updateSessionsCount(data.sessions.length);
  } catch (err) {
    list.innerHTML = `<div class="error-msg">Failed to load sessions: ${esc(err.message)}</div>`;
  }
}

async function loadSession(id) {
  try {
    const res = await fetch(`/api/session/${id}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    Object.assign(session, data.data.session);
    currentPromptIndex = session.generatedPrompts?.length || 0;
    closeModal('sessions-modal');

    const stage = data.data.stage || 1;
    setStage(stage);

    // Re-render whichever stage we're restoring to
    if (stage >= 2 && session.extraction) renderExtraction();
    if (stage >= 3 && session.questions?.length) renderQuestions();
    if (stage >= 4 && session.scopingDoc) {
      document.getElementById('scope-preview').innerHTML = marked.parse(session.scopingDoc);
      document.getElementById('scope-editor').value = session.scopingDoc;
      document.getElementById('approve-scope-btn').disabled = false;
      document.getElementById('scope-generating-badge').textContent = 'Loaded';
      document.getElementById('scope-generating-badge').classList.add('done');
    }
    if (stage >= 5 && session.architecture) renderArchitecture();
    if (stage === 7) buildPackageStage();

    showToast(`Session loaded — ${data.data.clientName}`);
  } catch (err) {
    showToast(`Failed to load session: ${err.message}`, 'error');
  }
}

async function deleteSession(id) {
  if (!confirm('Delete this session?')) return;
  try {
    await fetch(`/api/session/${id}`, { method: 'DELETE' });
    document.getElementById(`session-${id}`)?.remove();
    const remaining = document.querySelectorAll('.session-card').length;
    updateSessionsCount(remaining);
    if (!remaining) {
      document.getElementById('sessions-list').innerHTML =
        '<div class="modal-empty">No saved sessions yet.</div>';
    }
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

async function saveSession(stageNum) {
  try {
    const res = await fetch('/api/session/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, stage: stageNum })
    });
    const data = await res.json();
    if (data.success) {
      const count = (parseInt(document.getElementById('sessions-count').textContent) || 0) + 1;
      updateSessionsCount(count);
    }
  } catch {}
}

function updateSessionsCount(n) {
  const el = document.getElementById('sessions-count');
  el.textContent = n > 0 ? n : '';
}

// ─── FEEDBACK ─────────────────────────────────────────────────────────────

document.getElementById('open-feedback-btn').addEventListener('click', openFeedbackModal);

async function openFeedbackModal() {
  document.getElementById('feedback-modal').style.display = 'flex';
  await renderFeedbackBank();
}

async function renderFeedbackBank() {
  const list = document.getElementById('feedback-bank-list');
  list.innerHTML = '<div class="loading-row"><span class="spinner"></span>Loading...</div>';

  try {
    const res = await fetch('/api/feedback');
    const data = await res.json();

    updateFeedbackCount(data.feedback.length);

    if (!data.feedback.length) {
      list.innerHTML = '<div class="modal-empty">No feedback logged yet. Issues are logged from the Generate stage.</div>';
      return;
    }

    const sorted = [...data.feedback].reverse();
    list.innerHTML = `
      <table class="feedback-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Issue</th>
            <th>Detail</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(e => `
            <tr id="fb-${e.id}">
              <td class="fb-date">${new Date(e.date).toLocaleDateString('en-GB', { day:'2-digit', month:'short' })}</td>
              <td><span class="fb-type-badge">${esc(e.promptType || 'general')}</span></td>
              <td class="fb-issue">${esc(e.issue)}</td>
              <td class="fb-detail">${esc(e.detail || '—')}</td>
              <td>
                <button class="btn-fb-delete" onclick="deleteFeedback('${e.id}')">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M6 4V2h4v2M5 4v9h6V4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    list.innerHTML = `<div class="error-msg">Failed to load feedback bank: ${esc(err.message)}</div>`;
  }
}

async function deleteFeedback(id) {
  try {
    await fetch(`/api/feedback/${id}`, { method: 'DELETE' });
    document.getElementById(`fb-${id}`)?.remove();
    const remaining = document.querySelectorAll('.feedback-table tbody tr').length;
    updateFeedbackCount(remaining);
    if (!remaining) {
      document.getElementById('feedback-bank-list').innerHTML =
        '<div class="modal-empty">No feedback logged yet.</div>';
    }
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

function updateFeedbackCount(n) {
  const el = document.getElementById('feedback-count');
  el.textContent = n > 0 ? n : '';
}

function toggleFeedbackForm() {
  const form = document.getElementById('feedback-form');
  const chevron = document.getElementById('feedback-chevron');
  const open = form.style.display !== 'none';
  form.style.display = open ? 'none' : 'block';
  chevron.textContent = open ? '+' : '−';
}

document.getElementById('submit-feedback-btn').addEventListener('click', async () => {
  const tags = Array.from(document.querySelectorAll('.feedback-tags input:checked')).map(el => el.value);
  const detail = document.getElementById('feedback-detail').value.trim();
  const addToBank = document.getElementById('add-to-bank').checked;

  if (!tags.length && !detail) {
    showToast('Select at least one issue or add detail', 'error');
    return;
  }

  const file = session.promptQueue[currentPromptIndex - 1];
  const isCopilot = file?.type === 'Copilot Instructions';

  const entry = {
    client: session.extraction?.clientName || 'Unknown',
    promptType: isCopilot ? 'copilot-instructions' : 'azure-prompt',
    promptFile: file?.name || '',
    issue: tags.map(t => t.replace(/-/g, ' ')).join(', ') || 'General issue',
    detail,
    tags
  };

  // Always store in session
  if (session.generatedPrompts.length) {
    session.generatedPrompts[session.generatedPrompts.length - 1].feedback = entry;
  }

  if (addToBank) {
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry })
      });
      const count = (parseInt(document.getElementById('feedback-count').textContent) || 0) + 1;
      updateFeedbackCount(count);
      showToast('Feedback logged to bank');
    } catch {
      showToast('Saved to session only (bank write failed)', 'error');
    }
  } else {
    showToast('Feedback saved to session');
  }

  // Reset form
  document.querySelectorAll('.feedback-tags input').forEach(el => el.checked = false);
  document.getElementById('feedback-detail').value = '';
  toggleFeedbackForm();
});

// ─── MODAL HELPERS ────────────────────────────────────────────────────────

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

function closeModalOnOverlay(e, id) {
  if (e.target === document.getElementById(id)) closeModal(id);
}

// ─── TOAST ────────────────────────────────────────────────────────────────

function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast toast-${type} visible`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('visible'), 3000);
}

// ─── INIT: load counts ────────────────────────────────────────────────────

(async () => {
  try {
    const [sr, fr] = await Promise.all([
      fetch('/api/sessions').then(r => r.json()),
      fetch('/api/feedback').then(r => r.json())
    ]);
    updateSessionsCount(sr.sessions?.length || 0);
    updateFeedbackCount(fr.feedback?.length || 0);
  } catch {}
})();

function resetSession() {
  Object.assign(session, {
    extraction: null, questions: [], answers: {}, scopingDoc: '',
    architecture: null, generatedPrompts: [], trackerHtml: '', promptQueue: []
  });
  currentPromptIndex = 0;
  streamAccumulator = '';
  document.getElementById('input-text').value = '';
  document.getElementById('file-name').textContent = '';
  document.getElementById('file-upload').value = '';
  setStage(1);
}

// ─── ESCAPE HELPER ────────────────────────────────────────────────────────

function esc(str, forAttr = false) {
  if (str == null) return '';
  const s = String(str);
  if (forAttr) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── INIT ─────────────────────────────────────────────────────────────────

setStage(1);
