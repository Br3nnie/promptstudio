// ─── STATE ────────────────────────────────────────────────────────────────
const session = {
  extraction: null,
  extractionEdits: [],           // NEW: track edits/deselects in Stage 2
  questions: [],
  answers: {},
  rankedUseCases: [],             // NEW: ranked use cases from Stage 3
  scopingDoc: '',
  successCriteria: [],            // NEW: Stage 5
  testingOutcomes: [],            // NEW: Stage 5
  architecture: null,
  architectureAnalysis: '',       // NEW: streamed pros/cons analysis
  selectedFiles: [],              // NEW: which files user chose to generate
  namingConvention: '{component}-v{version}',  // NEW: file naming pattern
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
  const total = 8;  // Changed from 7 to 8
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

function switchTab(tab) {
  if (tab === 'preview') {
    document.getElementById('scope-preview').style.display = 'block';
    document.getElementById('scope-editor').style.display = 'none';
    document.getElementById('tab-preview').classList.add('active');
    document.getElementById('tab-edit').classList.remove('active');
  } else if (tab === 'edit') {
    document.getElementById('scope-editor').value = session.scopingDoc;
    document.getElementById('scope-preview').style.display = 'none';
    document.getElementById('scope-editor').style.display = 'block';
    document.getElementById('tab-preview').classList.remove('active');
    document.getElementById('tab-edit').classList.add('active');
  }
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

// ─── NEW UTILITIES FOR ENHANCED WORKFLOW ──────────────────────────────────

// Edit Reason Dialog
let currentEditItem = null;

function showEditReasonDialog(itemId, itemType, action, originalText) {
  const dialog = document.getElementById('edit-reason-dialog');
  currentEditItem = { itemId, itemType, action, originalText };
  
  const form = document.getElementById('edit-reason-form');
  form.reset();
  
  dialog.showModal();
}

document.getElementById('edit-reason-form').addEventListener('submit', (e) => {
  e.preventDefault();
  
  const reason = document.getElementById('reason-select').value;
  const detail = document.getElementById('reason-detail').value;
  
  if (!reason) {
    alert('Please select a reason');
    return;
  }
  
  const edit = {
    ...currentEditItem,
    reason,
    detail,
    timestamp: new Date().toISOString()
  };
  
  session.extractionEdits.push(edit);
  
  document.getElementById('edit-reason-dialog').close();
  currentEditItem = null;
});

document.getElementById('cancel-reason-btn').addEventListener('click', () => {
  document.getElementById('edit-reason-dialog').close();
  currentEditItem = null;
});

// Character counter for reason detail
document.getElementById('reason-detail').addEventListener('input', (e) => {
  document.getElementById('detail-char-count').textContent = e.target.value.length;
});

// Drag & Drop for Use Case Ranking
let draggedElement = null;

function initUseCaseRanking(useCases) {
  const container = document.getElementById('use-case-ranking');
  const rankingContainer = document.getElementById('ranking-container');
  
  if (!useCases || useCases.length <= 1) {
    rankingContainer.style.display = 'none';
    session.rankedUseCases = useCases || [];
    return;
  }
  
  rankingContainer.style.display = 'block';
  container.innerHTML = '';
  
  useCases.forEach((uc, index) => {
    const card = document.createElement('div');
    card.className = 'use-case-card';
    card.draggable = true;
    card.dataset.rank = index + 1;
    card.dataset.text = typeof uc === 'string' ? uc : uc.text || uc;
    
    card.innerHTML = `
      <span class="rank-badge">${index + 1}</span>
      <div class="use-case-content">${esc(typeof uc === 'string' ? uc : uc.text || uc)}</div>
      <div class="drag-handle">⋮⋮</div>
    `;
    
    card.addEventListener('dragstart', handleDragStart);
    card.addEventListener('dragover', handleDragOver);
    card.addEventListener('drop', handleDrop);
    card.addEventListener('dragend', handleDragEnd);
    
    container.appendChild(card);
  });
}

function handleDragStart(e) {
  draggedElement = e.currentTarget;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  
  const afterElement = getDragAfterElement(e.currentTarget.parentElement, e.clientY);
  const container = e.currentTarget.parentElement;
  
  if (afterElement == null) {
    container.appendChild(draggedElement);
  } else {
    container.insertBefore(draggedElement, afterElement);
  }
}

function handleDrop(e) {
  e.preventDefault();
}

function handleDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  updateRankNumbers();
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.use-case-card:not(.dragging)')];
  
  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function updateRankNumbers() {
  const cards = document.querySelectorAll('.use-case-card');
  session.rankedUseCases = [];
  
  cards.forEach((card, index) => {
    card.querySelector('.rank-badge').textContent = index + 1;
    card.dataset.rank = index + 1;
    session.rankedUseCases.push({
      rank: index + 1,
      text: card.dataset.text
    });
  });
}

// Success Criteria Management
function addCriterionItem(listId, text = '') {
  const list = document.getElementById(listId);
  const item = document.createElement('div');
  item.className = 'criteria-item';
  
  const id = `criterion-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  item.innerHTML = `
    <input type="checkbox" checked data-id="${id}">
    <textarea placeholder="Enter criterion..." data-id="${id}">${esc(text)}</textarea>
    <button class="edit-btn" onclick="focusCriterion('${id}')">✎</button>
    <button class="delete-btn" onclick="removeCriterion('${id}')">×</button>
  `;
  
  list.appendChild(item);
  
  // Focus the textarea if it's empty
  if (!text) {
    item.querySelector('textarea').focus();
  }
}

function focusCriterion(id) {
  const textarea = document.querySelector(`textarea[data-id="${id}"]`);
  if (textarea) textarea.focus();
}

function removeCriterion(id) {
  const item = document.querySelector(`textarea[data-id="${id}"]`)?.closest('.criteria-item');
  if (item && confirm('Remove this item?')) {
    item.remove();
  }
}

function collectCriteria() {
  const criteriaItems = document.querySelectorAll('#success-criteria-list .criteria-item');
  session.successCriteria = [];
  
  criteriaItems.forEach(item => {
    const checkbox = item.querySelector('input[type="checkbox"]');
    const textarea = item.querySelector('textarea');
    if (checkbox.checked && textarea.value.trim()) {
      session.successCriteria.push(textarea.value.trim());
    }
  });
  
  const outcomeItems = document.querySelectorAll('#testing-outcomes-list .criteria-item');
  session.testingOutcomes = [];
  
  outcomeItems.forEach(item => {
    const checkbox = item.querySelector('input[type="checkbox"]');
    const textarea = item.querySelector('textarea');
    if (checkbox.checked && textarea.value.trim()) {
      session.testingOutcomes.push(textarea.value.trim());
    }
  });
}

// File Selection Management
function updateFileSelectionSummary() {
  const checkboxes = document.querySelectorAll('#file-selection-list input[type="checkbox"]');
  const checked = Array.from(checkboxes).filter(cb => cb.checked).length;
  const total = checkboxes.length;
  
  document.getElementById('selected-count').textContent = checked;
  document.getElementById('total-count').textContent = total;
  
  session.selectedFiles = Array.from(checkboxes)
    .filter(cb => cb.checked)
    .map(cb => cb.dataset.fileId);
}

function updateNamingPreview() {
  const pattern = document.getElementById('naming-pattern').value;
  const preview = applyNamingConvention(pattern, {
    component: 'generate-sections',
    version: '2',
    date: new Date().toISOString().split('T')[0].replace(/-/g, ''),
    project: session.extraction?.clientName?.toLowerCase().substring(0, 3) || 'client'
  });
  
  document.getElementById('naming-preview-code').textContent = preview + '.md';
  session.namingConvention = pattern;
}

function applyNamingConvention(pattern, vars) {
  return pattern
    .replace(/{component}/g, vars.component)
    .replace(/{version}/g, vars.version)
    .replace(/{date}/g, vars.date)
    .replace(/{project}/g, vars.project);
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

  const useCases = extraction.useCases || [];
  const stakeholders = extraction.stakeholders || [];
  const constraints = extraction.constraints || [];
  const documentTypes = extraction.documentTypes || [];

  let html = `
    <div style="margin-bottom:24px">
      <div style="font-size:13.5px;color:var(--text-muted);margin-bottom:4px">Client / Project</div>
      <div style="font-size:16px;font-weight:600;color:var(--accent)">${esc(extraction.clientName || 'Unknown')}${extraction.projectName ? ` — <span style="font-weight:400">${esc(extraction.projectName)}</span>` : ''}</div>
    </div>
    
    <div style="margin-bottom:16px">
      <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:12px">Use Cases (${useCases.length})</div>
      <div style="display:flex;flex-direction:column;gap:10px">
  `;
  
  useCases.forEach((uc, i) => {
    const id = `use-case-${i}`;
    html += `
      <div class="extraction-edit-card" data-id="${id}">
        <input type="checkbox" checked data-type="useCase" data-id="${id}">
        <textarea data-id="${id}" data-original="${esc(uc, true)}" data-type="useCase">${esc(uc)}</textarea>
      </div>
    `;
  });
  
  html += `
      </div>
    </div>
    
    <div style="margin-bottom:16px">
      <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:12px">Stakeholders (${stakeholders.length})</div>
      <div style="display:flex;flex-direction:column;gap:10px">
  `;
  
  stakeholders.forEach((s, i) => {
    const id = `stakeholder-${i}`;
    const text = typeof s === 'string' ? s : `${s.name}${s.role ? ' · ' + s.role : ''}`;
    html += `
      <div class="extraction-edit-card" data-id="${id}">
        <input type="checkbox" checked data-type="stakeholder" data-id="${id}">
        <textarea data-id="${id}" data-original="${esc(text, true)}" data-type="stakeholder">${esc(text)}</textarea>
      </div>
    `;
  });
  
  html += `
      </div>
    </div>
    
    <div style="margin-bottom:16px">
      <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:12px">Constraints (${constraints.length})</div>
      <div style="display:flex;flex-direction:column;gap:10px">
  `;
  
  constraints.forEach((c, i) => {
    const id = `constraint-${i}`;
    html += `
      <div class="extraction-edit-card" data-id="${id}">
        <input type="checkbox" checked data-type="constraint" data-id="${id}">
        <textarea data-id="${id}" data-original="${esc(c, true)}" data-type="constraint">${esc(c)}</textarea>
      </div>
    `;
  });
  
  html += `
      </div>
    </div>
  `;
  
  container.innerHTML = html;
  
  // Attach event listeners for edit tracking
  container.querySelectorAll('textarea').forEach(textarea => {
    let lastValue = textarea.value;
    
    textarea.addEventListener('blur', () => {
      const currentValue = textarea.value;
      const originalValue = textarea.dataset.original;
      
      if (currentValue !== lastValue && currentValue !== originalValue) {
        showEditReasonDialog(
          textarea.dataset.id,
          textarea.dataset.type,
          'edited',
          originalValue
        );
        lastValue = currentValue;
      }
    });
  });
  
  container.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      if (!e.target.checked) {
        const textarea = container.querySelector(`textarea[data-id="${e.target.dataset.id}"]`);
        showEditReasonDialog(
          e.target.dataset.id,
          e.target.dataset.type,
          'deselected',
          textarea.dataset.original
        );
      }
    });
  });
}

document.getElementById('confirm-extraction-btn').addEventListener('click', async () => {
  hideError(2);
  const btn = document.getElementById('confirm-extraction-btn');
  setLoading(btn, 'Generating questions...');

  try {
    // Collect edited extraction
    const useCases = [];
    const stakeholders = [];
    const constraints = [];
    
    document.querySelectorAll('[data-type="useCase"]').forEach(el => {
      if (el.type === 'checkbox' && el.checked) {
        const textarea = document.querySelector(`textarea[data-id="${el.dataset.id}"]`);
        if (textarea && textarea.value.trim()) {
          useCases.push(textarea.value.trim());
        }
      }
    });
    
    document.querySelectorAll('[data-type="stakeholder"]').forEach(el => {
      if (el.type === 'checkbox' && el.checked) {
        const textarea = document.querySelector(`textarea[data-id="${el.dataset.id}"]`);
        if (textarea && textarea.value.trim()) {
          stakeholders.push(textarea.value.trim());
        }
      }
    });
    
    document.querySelectorAll('[data-type="constraint"]').forEach(el => {
      if (el.type === 'checkbox' && el.checked) {
        const textarea = document.querySelector(`textarea[data-id="${el.dataset.id}"]`);
        if (textarea && textarea.value.trim()) {
          constraints.push(textarea.value.trim());
        }
      }
    });
    
    // Update session with edited values
    session.extraction.useCases = useCases;
    session.extraction.stakeholders = stakeholders;
    session.extraction.constraints = constraints;
    
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

  // Initialize ranking AFTER questions are rendered
  if (session.extraction?.useCases?.length > 1) {
    setTimeout(() => {
      initUseCaseRanking(session.extraction.useCases);
    }, 100);
  }
}

document.getElementById('submit-questions-btn').addEventListener('click', async () => {
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

  const btn = document.getElementById('submit-questions-btn');  // Changed from submit-answers-btn
  setLoading(btn, 'Generating scope...');
  
  try {
    // Save ranking to KV
    if (session.rankedUseCases.length > 0) {
      const sessionId = `session-${Date.now()}`;
      await fetch('/api/save-ranking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          projectName: session.extraction?.projectName || 'Unnamed Project',
          rankedUseCases: session.rankedUseCases,
          clarifyAnswers: session.answers
        })
      });
    }
    
    setStage(4);
    generateScope();
  } catch (err) {
    showError(3, `Failed: ${err.message}`);
  } finally {
    clearLoading(btn);
  }
});

// ─── STAGE 4: SCOPE ────────────────────────────────────────────────────────

async function generateScope() {
  const preview = document.getElementById('scope-preview');
  // const badge = document.getElementById('scope-generating-badge');
  const approveBtn = document.getElementById('approve-scope-btn');

  preview.innerHTML = '<div class="loading-row"><span class="spinner"></span>Generating scoping document...</div>';
  streamAccumulator = '';
  approveBtn.disabled = true;
  // badge.textContent = 'Generating...';
  // badge.classList.remove('done');
  // badge.style.display = 'inline-block';

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

document.getElementById('approve-scope-btn').addEventListener('click', () => {
  setStage(5);
  generateSuccessCriteria();
});

// ─── STAGE 5: SUCCESS CRITERIA & TESTING ──────────────────────────────────

async function generateSuccessCriteria() {
  document.getElementById('success-criteria-loading').style.display = 'flex';
  document.getElementById('success-criteria-content').style.display = 'none';
  
  const statusEl = document.getElementById('success-criteria-status');
  statusEl.textContent = 'Generating success criteria...';
  
  let accumulatedText = '';
  
  try {
    await streamApi(
      '/api/generate-success-criteria',
      {
        scope: session.scopingDoc,
        useCases: session.rankedUseCases.length > 0 ? session.rankedUseCases : session.extraction.useCases
      },
      (chunk) => {
        accumulatedText += chunk;
      },
      () => {
        // Parse the markdown and populate lists
        parseSuccessCriteria(accumulatedText);
        
        document.getElementById('success-criteria-loading').style.display = 'none';
        document.getElementById('success-criteria-content').style.display = 'block';
      },
      (err) => {
        showError(5, `Failed to generate criteria: ${err.message}`);
        document.getElementById('success-criteria-loading').style.display = 'none';
      }
    );
  } catch (err) {
    showError(5, `Failed to generate criteria: ${err.message}`);
    document.getElementById('success-criteria-loading').style.display = 'none';
  }
}

function parseSuccessCriteria(markdown) {
  const lines = markdown.split('\n');
  let inCriteria = false;
  let inOutcomes = false;

  const criteria = [];
  const outcomes = [];

  lines.forEach(line => {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();

    // Detect any heading (##, ###, **, or bare text that is exactly the heading)
    const isHeading = /^#{1,6}\s/.test(trimmed) || /^\*\*[^*]+\*\*\s*$/.test(trimmed);

    if (/^#{1,6}\s+success criteria/i.test(trimmed) ||
        (isHeading && lower.includes('success criteria')) ||
        lower === 'success criteria') {
      inCriteria = true; inOutcomes = false; return;
    }
    if (/^#{1,6}\s+testing outcomes?/i.test(trimmed) ||
        (isHeading && lower.includes('testing outcome')) ||
        lower === 'testing outcomes' || lower === 'testing outcome') {
      inCriteria = false; inOutcomes = true; return;
    }
    // Any other heading closes both sections
    if (isHeading) {
      inCriteria = false; inOutcomes = false; return;
    }

    // Match numbered (1.) or bulleted (- or *) list items
    const numbered = trimmed.match(/^\d+\.\s+(.+)$/);
    const bulleted = trimmed.match(/^[-*]\s+(.+)$/);
    const text = numbered ? numbered[1] : bulleted ? bulleted[1] : null;

    if (text) {
      if (inCriteria) criteria.push(text);
      if (inOutcomes) outcomes.push(text);
    }
  });

  const criteriaList = document.getElementById('success-criteria-list');
  const outcomesList = document.getElementById('testing-outcomes-list');

  criteriaList.innerHTML = '';
  outcomesList.innerHTML = '';

  criteria.forEach(c => addCriterionItem('success-criteria-list', c));
  outcomes.forEach(o => addCriterionItem('testing-outcomes-list', o));
}

// Add criterion button handlers
document.getElementById('add-criterion-btn').addEventListener('click', () => {
  addCriterionItem('success-criteria-list');
});

document.getElementById('add-outcome-btn').addEventListener('click', () => {
  addCriterionItem('testing-outcomes-list');
});

// Guided questions toggle
document.getElementById('toggle-guided-questions').addEventListener('click', () => {
  const container = document.getElementById('guided-questions-container');
  const isVisible = container.style.display === 'block';
  container.style.display = isVisible ? 'none' : 'block';
  
  if (!isVisible) {
    // Populate guided questions
    document.getElementById('guided-questions-list').innerHTML = `
      <div class="guided-question-item">
        <label>What is the maximum acceptable response time?</label>
        <input type="text" id="guided-q1" placeholder="e.g., 45 seconds">
      </div>
      <div class="guided-question-item">
        <label>What error rate is tolerable?</label>
        <input type="text" id="guided-q2" placeholder="e.g., Less than 1% fabricated content">
      </div>
      <div class="guided-question-item">
        <label>Which features are must-have vs nice-to-have?</label>
        <textarea id="guided-q3" rows="3" placeholder="List critical features..."></textarea>
      </div>
    `;
  }
});

// Apply guided answers
document.getElementById('apply-guided-answers').addEventListener('click', () => {
  const q1 = document.getElementById('guided-q1')?.value;
  const q2 = document.getElementById('guided-q2')?.value;
  const q3 = document.getElementById('guided-q3')?.value;
  
  if (q1) addCriterionItem('success-criteria-list', `Response time under ${q1}`);
  if (q2) addCriterionItem('success-criteria-list', `Error rate: ${q2}`);
  if (q3) addCriterionItem('testing-outcomes-list', q3);
  
  document.getElementById('guided-questions-container').style.display = 'none';
  showToast('Guided answers added to criteria');
});

// Continue to Architecture button
document.getElementById('continue-to-architecture').addEventListener('click', () => {
  collectCriteria();
  
  if (session.successCriteria.length === 0) {
    showError(5, 'Please add at least one success criterion');
    return;
  }
  
  setStage(6);
  generateArchitectureAnalysis();
});

// ─── STAGE 6: ARCHITECTURE ────────────────────────────────────────────────

async function generateArchitectureAnalysis() {
  document.getElementById('architecture-loading').style.display = 'flex';
  document.getElementById('architecture-content').style.display = 'none';
  
  const statusEl = document.getElementById('architecture-status');
  statusEl.textContent = 'Analyzing architecture options...';
  
  session.architectureAnalysis = '';
  const container = document.getElementById('architecture-recommendation');
  container.innerHTML = '';
  
  try {
    await streamApi(
      '/api/generate-architecture-analysis',
      {
        scope: session.scopingDoc,
        useCases: session.rankedUseCases.length > 0 ? session.rankedUseCases : session.extraction.useCases,
        successCriteria: session.successCriteria,
        testingOutcomes: session.testingOutcomes
      },
      (chunk) => {
        session.architectureAnalysis += chunk;
        container.innerHTML = marked.parse(session.architectureAnalysis);
      },
      () => {
        // Parse file structure from the markdown
        parseFileStructure(session.architectureAnalysis);
        
        document.getElementById('architecture-loading').style.display = 'none';
        document.getElementById('architecture-content').style.display = 'block';
        
        // Initialize naming convention
        updateNamingPreview();
      },
      (err) => {
        showError(6, `Failed to generate architecture: ${err.message}`);
        document.getElementById('architecture-loading').style.display = 'none';
      }
    );
  } catch (err) {
    showError(6, `Failed to generate architecture: ${err.message}`);
    document.getElementById('architecture-loading').style.display = 'none';
  }
}

function parseFileStructure(markdown) {
  // Extract file list from the markdown
  const files = [];
  const lines = markdown.split('\n');
  
  let inFileSection = false;
  lines.forEach(line => {
    if (line.includes('FILE STRUCTURE') || line.includes('File Structure')) {
      inFileSection = true;
    } else if (line.match(/^-\s+(.+?)\s*\(REQUIRED\)/i)) {
      const name = line.replace(/^-\s+/, '').replace(/\s*\(REQUIRED\)/i, '').trim();
      files.push({ id: toFileId(name), name, required: true, description: 'Required' });
    } else if (line.match(/^-\s+(.+)/)) {
      const name = line.replace(/^-\s+/, '').trim();
      if (inFileSection && name && !name.startsWith('#')) {
        files.push({ id: toFileId(name), name, required: false, description: '' });
      }
    }
  });
  
  // Render file selection list
  const fileList = document.getElementById('file-selection-list');
  fileList.innerHTML = '';
  
  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'file-item' + (file.required ? ' disabled' : '');
    item.innerHTML = `
      <input type="checkbox" 
             ${file.required ? 'checked disabled' : 'checked'} 
             data-file-id="${file.id}">
      <label>
        <span class="file-name">${esc(file.name)}</span>
        <span class="file-description">${esc(file.description || 'Generated prompt file')}</span>
      </label>
    `;
    fileList.appendChild(item);
  });
  
  // Attach change listeners
  fileList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', updateFileSelectionSummary);
  });
  
  updateFileSelectionSummary();
}

function toFileId(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Naming convention handlers
document.getElementById('naming-pattern').addEventListener('input', updateNamingPreview);

document.getElementById('template-dropdown-btn').addEventListener('click', () => {
  const suggestions = document.getElementById('template-suggestions');
  suggestions.style.display = suggestions.style.display === 'none' ? 'block' : 'none';
});

document.querySelectorAll('.template-option').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const template = e.target.dataset.template;
    document.getElementById('naming-pattern').value = template;
    updateNamingPreview();
    document.getElementById('template-suggestions').style.display = 'none';
  });
});

// Continue to Generate button
document.getElementById('continue-to-generate').addEventListener('click', () => {
  if (session.selectedFiles.length === 0) {
    showError(6, 'Please select at least one file to generate');
    return;
  }
  
  setStage(7);
  startGeneration();
});

function startGeneration() {
  // Build the prompt queue from the user's selected files (selectedFiles is an array of ID strings)
  session.promptQueue = session.selectedFiles.map((fileId) => ({
    id: fileId,
    name: applyNamingConvention(session.namingConvention, {
      component: fileId,
      version: '1.0',
      project: session.architecture?.filePrefix || 'project',
      date: new Date().toISOString().slice(0, 10)
    })
  }));

  // Reset state for a fresh generation run
  currentPromptIndex = 0;
  session.generatedPrompts = [];
  streamAccumulator = '';

  // Navigate to Stage 7 and start generating the first prompt
  setStage(7);
  generateCurrentPrompt();
}

// ─── STAGE 7: GENERATE ────────────────────────────────────────────────────

function buildPromptMeta(file, index) {
  const isCopilot = file.type === 'Copilot Instructions';
  return {
    promptType: isCopilot ? 'copilot-instructions' : 'azure-prompt',
    promptName: isCopilot ? null : file.name.replace(`${session.architecture?.filePrefix || ''}-`, '').replace('-v1.0.md', ''),
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
    setStage(8);
    buildPackageStage();
  }
});

// ─── STAGE 8: PACKAGE ─────────────────────────────────────────────────────

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
    extraction: null,
    extractionEdits: [],
    questions: [],
    answers: {},
    rankedUseCases: [],
    scopingDoc: '',
    successCriteria: [],
    testingOutcomes: [],
    architecture: null,
    architectureAnalysis: '',
    selectedFiles: [],
    namingConvention: '{component}-v{version}',
    generatedPrompts: [],
    trackerHtml: '',
    promptQueue: []
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

// Add extraction-edit-card CSS class if not in CSS file
if (!document.querySelector('style#dynamic-extraction-styles')) {
  const style = document.createElement('style');
  style.id = 'dynamic-extraction-styles';
  style.textContent = `
    .extraction-edit-card {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px;
      background: var(--surface-subtle);
      border: 1.5px solid var(--border);
      border-radius: var(--radius-sm);
      transition: all 0.15s;
    }
    
    .extraction-edit-card:hover {
      background: var(--surface);
      border-color: var(--border-strong);
    }
    
    .extraction-edit-card input[type="checkbox"] {
      margin-top: 6px;
      width: 16px;
      height: 16px;
      cursor: pointer;
      flex-shrink: 0;
    }
    
    .extraction-edit-card textarea {
      flex: 1;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 8px 10px;
      font-size: 14px;
      font-family: var(--sans);
      line-height: 1.5;
      resize: vertical;
      min-height: 60px;
      background: var(--surface);
      transition: all 0.15s;
    }
    
    .extraction-edit-card textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-subtle);
    }
  `;
  document.head.appendChild(style);
}

setStage(1);
