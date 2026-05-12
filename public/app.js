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
  promptQueue: [],
  stagesCompleted: {}             // NEW: Track which stages are complete
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

function markStageComplete(n) {
  session.stagesCompleted[n] = true;
  const el = document.getElementById(`nav-status-${n}`);
  if (el) el.textContent = '✓';
  updateCompletenessBar();
}

function updateCompletenessBar() {
  const completed = Object.keys(session.stagesCompleted).length;
  const total = 8;
  const percentage = (completed / total) * 100;
  
  const countEl = document.getElementById('progress-count');
  if (countEl) countEl.textContent = `${completed}/${total} stages complete`;
  
  const fillEl = document.getElementById('top-progress-fill');
  if (fillEl) fillEl.style.width = `${percentage}%`;
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

// ─── NAVIGATION HANDLERS ──────────────────────────────────────────────────

// Make sidebar navigation clickable
document.querySelectorAll('.stage-nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const targetStage = parseInt(item.dataset.stage);
    const stageCompleted = session.stagesCompleted[targetStage] || targetStage === 1;
    
    if (stageCompleted) {
      setStage(targetStage);
    } else {
      showToast('Complete previous stages first');
    }
  });
});


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
    markStageComplete(1);
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

  const useCases      = extraction.useCases      || [];
  const stakeholders  = extraction.stakeholders  || [];
  const constraints   = extraction.constraints   || [];
  const ambiguities   = extraction.ambiguities   || [];
  const documentTypes = extraction.documentTypes || extraction.inputDocumentTypes || [];
  const outputPrefs   = extraction.outputPreferences || extraction.outputFormats || [];
  const complexity    = extraction.complexity    || '';
  const archHint      = extraction.architectureHint || extraction.architectureRecommendation || '';

  // ── hidden edit-tracking form (never visible, always in DOM for confirm handler) ──
  let editForm = `<div id="extraction-edit-form" style="display:none">`;

  useCases.forEach((uc, i) => {
    const id = `use-case-${i}`;
    editForm += `<div class="extraction-edit-card" data-id="${id}">
      <input type="checkbox" checked data-type="useCase" data-id="${id}">
      <textarea data-id="${id}" data-original="${esc(uc, true)}" data-type="useCase">${esc(uc)}</textarea>
    </div>`;
  });
  stakeholders.forEach((s, i) => {
    const id = `stakeholder-${i}`;
    const text = typeof s === 'string' ? s : `${s.name}${s.role ? ' · ' + s.role : ''}`;
    editForm += `<div class="extraction-edit-card" data-id="${id}">
      <input type="checkbox" checked data-type="stakeholder" data-id="${id}">
      <textarea data-id="${id}" data-original="${esc(text, true)}" data-type="stakeholder">${esc(text)}</textarea>
    </div>`;
  });
  constraints.forEach((c, i) => {
    const id = `constraint-${i}`;
    editForm += `<div class="extraction-edit-card" data-id="${id}">
      <input type="checkbox" checked data-type="constraint" data-id="${id}">
      <textarea data-id="${id}" data-original="${esc(c, true)}" data-type="constraint">${esc(c)}</textarea>
    </div>`;
  });
  editForm += `</div>`;

  // ── visual card layout ────────────────────────────────────────────────────
  const pills = (arr, cls = '') => arr.map(t =>
    `<span class="ex-pill${cls ? ' ' + cls : ''}">${esc(typeof t === 'string' ? t : t.text || t)}</span>`
  ).join('');

  const stakeholderRows = stakeholders.map(s => {
    const name = typeof s === 'string' ? s : (s.name || s);
    const role = typeof s === 'object' ? (s.role || '') : '';
    return `<div class="ex-stakeholder-row">
      <span class="ex-stakeholder-name">${esc(name)}</span>
      ${role ? `<span class="ex-stakeholder-role">· ${esc(role)}</span>` : ''}
    </div>`;
  }).join('');

  const complexityClass = complexity
    ? ({ high: 'ex-badge-red', medium: 'ex-badge-amber', low: 'ex-badge-green' }[complexity.toLowerCase()] || 'ex-badge-amber')
    : '';

  let visual = `
    <div class="ex-client-row">
      <span class="ex-client-label">Client / Project</span>
      <span class="ex-client-name">${esc(extraction.clientName || 'Unknown')}${extraction.projectName ? ` <span class="ex-project-name">— ${esc(extraction.projectName)}</span>` : ''}</span>
    </div>

    <div class="ex-grid-top">
      <div class="ex-card">
        <div class="ex-card-label">Use Cases (${useCases.length})</div>
        <div class="ex-pills">${pills(useCases)}</div>
      </div>
      <div class="ex-card">
        <div class="ex-card-label">Stakeholders</div>
        <div class="ex-stakeholders">${stakeholderRows || '<span class="ex-empty">None detected</span>'}</div>
      </div>
    </div>`;

  if (documentTypes.length || outputPrefs.length) {
    visual += `<div class="ex-grid-top">`;
    if (documentTypes.length) {
      visual += `<div class="ex-card">
        <div class="ex-card-label">Input Document Types</div>
        <div class="ex-pills">${pills(documentTypes)}</div>
      </div>`;
    }
    if (outputPrefs.length) {
      visual += `<div class="ex-card">
        <div class="ex-card-label">Output Preferences</div>
        <div class="ex-pills">${pills(outputPrefs)}</div>
      </div>`;
    }
    visual += `</div>`;
  }

  if (constraints.length) {
    visual += `<div class="ex-card ex-card-full">
      <div class="ex-card-label">Constraints Detected</div>
      <div class="ex-pills">${pills(constraints, 'ex-pill-amber')}</div>
    </div>`;
  }

  if (ambiguities.length) {
    visual += `<div class="ex-card ex-card-full">
      <div class="ex-card-label">Ambiguities (To Clarify)</div>
      <div class="ex-pills">${pills(ambiguities, 'ex-pill-amber')}</div>
    </div>`;
  }

  if (complexity || archHint) {
    visual += `<div class="ex-grid-bottom">`;
    if (complexity) {
      visual += `<div class="ex-card">
        <div class="ex-card-label">Complexity</div>
        <span class="ex-badge ${complexityClass}">${esc(complexity.charAt(0).toUpperCase() + complexity.slice(1))}</span>
      </div>`;
    }
    if (archHint) {
      visual += `<div class="ex-card">
        <div class="ex-card-label">Architecture Hint</div>
        <span class="ex-badge ex-badge-neutral">${esc(archHint)}</span>
      </div>`;
    }
    visual += `</div>`;
  }

  container.innerHTML = visual + editForm;

  // ── attach edit-tracking listeners to the hidden form ────────────────────
  container.querySelectorAll('textarea').forEach(textarea => {
    let lastValue = textarea.value;
    textarea.addEventListener('blur', () => {
      const currentValue = textarea.value;
      const originalValue = textarea.dataset.original;
      if (currentValue !== lastValue && currentValue !== originalValue) {
        showEditReasonDialog(textarea.dataset.id, textarea.dataset.type, 'edited', originalValue);
        lastValue = currentValue;
      }
    });
  });

  container.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      if (!e.target.checked) {
        const textarea = container.querySelector(`textarea[data-id="${e.target.dataset.id}"]`);
        showEditReasonDialog(e.target.dataset.id, e.target.dataset.type, 'deselected', textarea.dataset.original);
      }
    });
  });

  // Inject Stage 2 visual styles if not already present
  if (!document.querySelector('style#ex-styles')) {
    const s = document.createElement('style');
    s.id = 'ex-styles';
    s.textContent = `
      .ex-client-row { margin-bottom: 20px; }
      .ex-client-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; display: block; margin-bottom: 4px; }
      .ex-client-name { font-size: 17px; font-weight: 700; color: var(--text); }
      .ex-project-name { font-weight: 400; color: var(--text-muted); }
      .ex-grid-top { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
      .ex-grid-bottom { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
      .ex-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; }
      .ex-card-full { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px 20px; margin-bottom: 16px; }
      .ex-card-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted); margin-bottom: 12px; }
      .ex-pills { display: flex; flex-wrap: wrap; gap: 8px; }
      .ex-pill { background: var(--surface-subtle); border: 1px solid var(--border); border-radius: 20px; padding: 5px 12px; font-size: 13px; color: var(--text); line-height: 1.4; }
      .ex-pill-amber { background: #fdf8ec; border-color: #e8d5a0; color: #7a5f1a; }
      .ex-stakeholders { display: flex; flex-direction: column; gap: 8px; }
      .ex-stakeholder-row { display: flex; align-items: baseline; gap: 6px; }
      .ex-stakeholder-name { font-size: 14px; font-weight: 600; color: var(--text); }
      .ex-stakeholder-role { font-size: 13px; color: var(--text-muted); }
      .ex-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 600; }
      .ex-badge-red    { background: #fdecea; color: #b91c1c; border: 1px solid #fca5a5; }
      .ex-badge-amber  { background: #fdf8ec; color: #92400e; border: 1px solid #fcd34d; }
      .ex-badge-green  { background: #ecfdf5; color: #065f46; border: 1px solid #6ee7b7; }
      .ex-badge-neutral{ background: var(--surface-subtle); color: var(--text); border: 1px solid var(--border); }
      .ex-empty { font-size: 13px; color: var(--text-muted); font-style: italic; }
    `;
    document.head.appendChild(s);
  }
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
    markStageComplete(2);
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
    
    markStageComplete(3);
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
        
        // Show print button
        const printBtn = document.getElementById('print-scope-btn');
        if (printBtn) printBtn.style.display = 'flex';
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
  markStageComplete(4);
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
  
  markStageComplete(5);
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
  
  // Create card-based architecture visual
  const architectureHtml = createArchitectureCards(files);
  const visualContainer = document.getElementById('architecture-recommendation');
  if (visualContainer) visualContainer.innerHTML = architectureHtml;
  
  // Show print button
  const printBtn = document.getElementById('print-architecture-btn');
  if (printBtn) printBtn.style.display = 'flex';
  
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

  // Save full file objects so promptQueue can be built later
  session.architectureFiles = files;

  updateFileSelectionSummary();
}

function createArchitectureCards(files) {
  // Extract token estimates from the markdown
  const tokenEstimates = extractTokenEstimates(session.architectureAnalysis);
  
  // Separate files into categories
  const orchestration = files.find(f => f.name.toLowerCase().includes('copilot') || f.name.toLowerCase().includes('instruction'));
  const prompts = files.filter(f => !f.name.toLowerCase().includes('copilot') && !f.name.toLowerCase().includes('template') && !f.name.toLowerCase().includes('instruction'));
  const reference = files.find(f => f.name.toLowerCase().includes('template'));
  
  let html = '<div class="arch-visual">';
  
  // Orchestration layer
  if (orchestration) {
    const tokens = tokenEstimates[orchestration.name] || '~2,500';
    html += `
      <div class="arch-card">
        <div class="arch-header">
          <span>${orchestration.name}</span>
          <span class="arch-badge orchestration">Orchestration</span>
        </div>
        <div class="arch-desc">Router and orchestration layer. Receives user requests, identifies the required operation, and calls the appropriate Azure prompt.</div>
        <div class="arch-meta">
          <span>${tokens} tokens</span>
          <span>Character limit: 8,000</span>
        </div>
      </div>
    `;
  }
  
  html += '<div class="arch-connector">↓ Routes to Azure Prompts</div>';
  html += '<div class="arch-grid">';
  
  // Azure Prompts
  prompts.forEach(file => {
    const tokens = tokenEstimates[file.name] || '';
    const desc = getFileDescription(file.name);
    html += `
      <div class="arch-card">
        <div class="arch-header">
          <span>${file.name}</span>
          <span class="arch-badge prompt">Prompt</span>
        </div>
        <div class="arch-desc">${desc}</div>
        ${tokens ? `<div class="arch-meta"><span>${tokens} tokens</span></div>` : ''}
      </div>
    `;
  });
  
  html += '</div>';
  
  // Reference template
  if (reference) {
    const tokens = tokenEstimates[reference.name] || '~3,200';
    html += `
      <div class="arch-connector">↓ References shared template</div>
      <div class="arch-card">
        <div class="arch-header">
          <span>${reference.name}</span>
          <span class="arch-badge reference">Reference</span>
        </div>
        <div class="arch-desc">Centralized template structure referenced by all prompts. Defines core sections and appendices with exact headings.</div>
        <div class="arch-meta">
          <span>${tokens} tokens</span>
          <span>Shared across all prompts</span>
        </div>
      </div>
    `;
  }
  
  html += '</div>';
  return html;
}

function extractTokenEstimates(markdown) {
  const estimates = {};
  const lines = markdown.split('\n');
  let currentFile = null;
  
  lines.forEach(line => {
    // Match file names
    const fileMatch = line.match(/^-\s+(.+?)(?:\s*\(|:|\s*$)/);
    if (fileMatch) {
      currentFile = fileMatch[1].trim();
    }
    
    // Match token estimates
    const tokenMatch = line.match(/(\d+[,\d]*)\s*tokens?/i);
    if (tokenMatch && currentFile) {
      estimates[currentFile] = `~${tokenMatch[1]}`;
    }
  });
  
  return estimates;
}

function getFileDescription(fileName) {
  const descriptions = {
    'generate-sections': 'Generates IC paper sections with two-pass citation approach.',
    'ddq-assessment': 'Analyzes DDQ responses and flags risks or gaps.',
    'source-analysis': 'Extracts structured data from SharePoint documents.',
    'quality-review': 'Validates output against quality standards.',
    'comparative-analysis': 'Compares current submission against benchmarks.'
  };
  
  const key = Object.keys(descriptions).find(k => fileName.toLowerCase().includes(k));
  return descriptions[key] || 'Specialized prompt for this workflow.';
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
  
  // Build architecture object from selected files and naming convention
  const clientPrefix = (session.extraction?.clientName || 'client')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .substring(0, 3);
  
  session.architecture = {
    filePrefix: clientPrefix,
    fileNamingConvention: session.namingConvention || '{component}-v{version}',
    recommendation: 'modular', // Could parse from architectureAnalysis if needed
    promptCount: session.selectedFiles.length
  };

  // Build the prompt queue from selected file IDs, resolving back to full objects
  session.promptQueue = (session.architectureFiles || [])
    .filter(f => session.selectedFiles.includes(f.id))
    .map(f => ({
      ...f,
      type: (f.name.toLowerCase().includes('copilot') || f.name.toLowerCase().includes('instruction'))
        ? 'Copilot Instructions'
        : 'Azure Prompt'
    }));

  currentPromptIndex = 0;

  markStageComplete(6);
  setStage(7);
  generateCurrentPrompt();
});

// ─── PRINT HANDLERS ────────────────────────────────────────────────────────

// Architecture print button
document.getElementById('print-architecture-btn')?.addEventListener('click', () => {
  const printContent = `
    <html>
    <head>
      <title>Architecture - ${session.extraction?.projectName || 'Project'}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 40px; line-height: 1.6; }
        h1 { font-size: 24px; margin-bottom: 24px; }
        .arch-card { border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin-bottom: 16px; page-break-inside: avoid; }
        .arch-header { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
        .arch-badge { font-size: 11px; padding: 4px 8px; border-radius: 4px; margin-left: 8px; }
        .arch-desc { margin-bottom: 12px; }
        .arch-meta { font-size: 13px; color: #666; }
        .arch-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
        .arch-connector { text-align: center; margin: 16px 0; color: #666; }
        @media print { .no-print { display: none; } }
      </style>
    </head>
    <body>
      <h1>Architecture Recommendation</h1>
      ${document.getElementById('architecture-recommendation')?.innerHTML || ''}
    </body>
    </html>
  `;
  
  const printWindow = window.open('', '_blank');
  printWindow.document.write(printContent);
  printWindow.document.close();
  printWindow.print();
});

// Scope print button
document.getElementById('print-scope-btn')?.addEventListener('click', () => {
  const printContent = `
    <html>
    <head>
      <title>Scoping Document - ${session.extraction?.projectName || 'Project'}</title>
      <style>
        @page { margin: 2cm; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          line-height: 1.6;
          color: #1a1917;
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
        }
        h1 { font-size: 24px; margin-top: 32px; margin-bottom: 16px; border-bottom: 2px solid #e2e0da; padding-bottom: 8px; }
        h2 { font-size: 20px; margin-top: 24px; margin-bottom: 12px; color: #1a3a5c; }
        h3 { font-size: 16px; margin-top: 16px; margin-bottom: 8px; }
        table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
        th, td { border: 1px solid #e2e0da; padding: 8px 12px; text-align: left; }
        th { background: #f7f6f3; font-weight: 600; }
        ul, ol { margin: 12px 0; padding-left: 24px; }
        li { margin: 6px 0; }
        p { margin: 12px 0; }
        strong { font-weight: 600; }
        code { background: #f7f6f3; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 13px; }
        pre { background: #f7f6f3; padding: 16px; border-radius: 6px; overflow-x: auto; }
        hr { border: none; border-top: 1px solid #e2e0da; margin: 24px 0; }
        @media print { .no-print { display: none; } }
      </style>
    </head>
    <body>
      ${document.getElementById('scope-display')?.innerHTML || ''}
    </body>
    </html>
  `;
  
  const printWindow = window.open('', '_blank');
  printWindow.document.write(printContent);
  printWindow.document.close();
  printWindow.print();
});

// ─── STAGE 7: GENERATE ────────────────────────────────────────────────────

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
    markStageComplete(7);
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

// ─── STAGE 8: EXPORT TO DELIVERY FRAMEWORK ───────────────────────────────

function buildDeliveryHandoff() {
  const extraction = session.extraction || {};
  const prefix = extraction.clientName || 'Unknown';

  // ── Stakeholders ─────────────────────────────────────────────────────────
  const rawStakeholders = extraction.stakeholders || [];
  const stakeholders = rawStakeholders.map(s =>
    typeof s === 'string' ? { name: s, role: '' } : { name: s.name || s, role: s.role || '' }
  );

  // ── Requirements list from scoping doc sections ───────────────────────────
  // We derive structured requirements from the ranked use cases plus clarify answers.
  const useCases = session.rankedUseCases.length > 0
    ? session.rankedUseCases.map(uc => uc.text || uc)
    : (extraction.useCases || []);

  const requirementsList = useCases.map((text, i) => ({
    id: `REQ-${String(i + 1).padStart(3, '0')}`,
    description: text,
    priority: i === 0 ? 'High' : i < 3 ? 'Medium' : 'Low',
    acceptanceCriterion: session.successCriteria[i] || ''
  }));

  // ── Agent scope from scoping doc ──────────────────────────────────────────
  // Parse in-scope / out-of-scope lines from the markdown scoping document.
  const inScope = [];
  const outOfScope = [];
  if (session.scopingDoc) {
    const lines = session.scopingDoc.split('\n');
    let mode = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^#{1,6}\s.*out.of.scope/i.test(trimmed) || /out.of.scope/i.test(trimmed)) { mode = 'out'; continue; }
      if (/^#{1,6}\s.*in.scope/i.test(trimmed) || /\bin.scope\b/i.test(trimmed)) { mode = 'in'; continue; }
      if (/^#{1,6}\s/.test(trimmed)) { mode = null; continue; }
      const bullet = trimmed.match(/^[-*]\s+(.+)$/) || trimmed.match(/^\d+\.\s+(.+)$/);
      if (bullet) {
        if (mode === 'in') inScope.push(bullet[1]);
        if (mode === 'out') outOfScope.push(bullet[1]);
      }
    }
  }

  // ── Agent spec from Stage 7 generated prompts ─────────────────────────────
  const proposedAgentSpec = {
    architecture: session.architectureAnalysis
      ? session.architectureAnalysis.substring(0, 800) + (session.architectureAnalysis.length > 800 ? '…' : '')
      : '',
    files: session.generatedPrompts.map(p => ({
      filename: p.filename,
      type: p.type,
      description: p.description
    }))
  };

  return {
    exportedAt: new Date().toISOString(),
    exportVersion: '1.0',
    projectName: extraction.projectName || extraction.clientName || 'Unnamed Project',
    clientName: prefix,
    stakeholders,
    requirementsList,
    agentScope: {
      inScope,
      outOfScope
    },
    successCriteria: session.successCriteria,
    proposedAgentSpec
  };
}

document.getElementById('export-handoff-btn').addEventListener('click', () => {
  const btn = document.getElementById('export-handoff-btn');
  try {
    const handoff = buildDeliveryHandoff();
    const json = JSON.stringify(handoff, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const prefix = (handoff.clientName || 'client').toLowerCase().replace(/\s+/g, '-');
    a.href = url;
    a.download = `${prefix}-delivery-handoff.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Handoff file exported — ready for Delivery Framework');
  } catch (err) {
    showToast(`Export failed: ${err.message}`, 'error');
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
    promptQueue: [],
    architectureFiles: []
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