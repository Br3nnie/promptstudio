require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const archiver = require('archiver');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function parseJSON(text) {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  return JSON.parse(stripped);
}

// ─── STORAGE — Vercel KV in production, in-memory fallback for local dev ────
const USE_KV = !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
let kv;
if (USE_KV) kv = require('@vercel/kv').kv;

// In-memory fallback (local dev without KV configured)
const _localSessions = new Map();
let _localFeedback = [];
let _localRankings = [];

async function kvGet(key) {
  if (USE_KV) return kv.get(key);
  if (key === 'feedback-bank') return _localFeedback;
  if (key.startsWith('ranking:')) return _localRankings.find(r => r.sessionId === key.replace('ranking:', ''));
  return _localSessions.get(key) || null;
}

async function kvSet(key, value) {
  if (USE_KV) return kv.set(key, value);
  if (key === 'feedback-bank') { _localFeedback = value; return; }
  if (key.startsWith('ranking:')) {
    const sessionId = key.replace('ranking:', '');
    _localRankings = _localRankings.filter(r => r.sessionId !== sessionId);
    _localRankings.push(value);
    return;
  }
  _localSessions.set(key, value);
}

async function kvDel(key) {
  if (USE_KV) return kv.del(key);
  if (key.startsWith('ranking:')) {
    const sessionId = key.replace('ranking:', '');
    _localRankings = _localRankings.filter(r => r.sessionId !== sessionId);
    return;
  }
  _localSessions.delete(key);
}

async function kvKeys(pattern) {
  if (USE_KV) return kv.keys(pattern);
  const prefix = pattern.replace('*', '');
  return [..._localSessions.keys()].filter(k => k.startsWith(prefix));
}

async function kvLpush(key, value) {
  if (USE_KV) return kv.lpush(key, value);
  // In-memory: rankings are already stored in _localRankings
}

async function kvLrange(key, start, stop) {
  if (USE_KV) return kv.lrange(key, start, stop);
  // In-memory: return all ranking session IDs
  return _localRankings.map(r => r.sessionId);
}

async function loadFeedbackBank() {
  return (await kvGet('feedback-bank')) || [];
}

// ─── SHARED CONSTRAINTS (cached by Anthropic across requests) ──────────────
const PLATFORM_CONSTRAINTS = `## Platform Constraint Rules — apply to ALL outputs

| Constraint | Rule | Origin |
|---|---|---|
| Copilot Instructions character limit | Hard cap 8,000 chars; warn at 7,500 | BBB v4.3 |
| Responsible AI filter | Never use: MANDATORY, PROHIBITED, "Do NOT", "must not", "will not be tolerated". Use descriptive equivalents: "The assistant provides...", "When the user asks X, the assistant returns Y" | BBB regression |
| Output format | All Copilot-facing outputs: markdown only, never JSON | BBB regression |
| Timeout protection | >3 use cases or >500-line template → recommend two-pass / discrete stage approach | BBB v5.x |
| Template centralisation | If >1 prompt references the same structure → flag and create a shared reference prompt | BBB architecture review |
| SharePoint connector | FederatedKnowledgeSearchOperation only — no autonomous file discovery | BBB regression |

## Encoded BBB Lessons
- A scoping document with explicit sign-off must exist before any prompt is generated
- Monolithic prompts time out when they contain more than 3 use cases — recommend modular
- Never duplicate template structures across prompts — create a shared reference
- JSON output breaks the Copilot Studio UI — always use markdown
- Responsible AI filters trigger on imperative/prohibitive language — use descriptive phrasing
- Version all artefacts from v1.0 from the start
- SharePoint is RAG-only via FederatedKnowledgeSearchOperation — never assume autonomous file discovery`;

// ─── STAGE 1: EXTRACT ──────────────────────────────────────────────────────
app.post('/api/extract', async (req, res) => {
  const { input } = req.body;
  if (!input?.trim()) return res.status(400).json({ success: false, error: 'Input is required' });

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: [
        {
          type: 'text',
          text: `You are an AI agent scoping assistant for Leancrest, a professional services firm that builds AI agents for clients using Microsoft Copilot Studio and Azure Prompt Library.

Analyse unstructured input (voice note transcripts, emails, text briefs) and extract structured information for a prompt engineering engagement.

${PLATFORM_CONSTRAINTS}

Return ONLY valid JSON — no markdown, no explanation, no code fences:
{
  "clientName": "string or null",
  "projectName": "string or null",
  "useCases": ["array of identified use cases as short phrases"],
  "stakeholders": [{"name": "string", "role": "string"}],
  "documentTypes": ["array of input document types mentioned"],
  "platformRefs": ["array of platform or tool references"],
  "constraints": ["array of constraints, limits, or requirements mentioned"],
  "outputPrefs": ["array of output format preferences"],
  "ambiguities": ["array of unclear points needing clarification"],
  "complexityScore": "low|medium|high",
  "architectureHint": "monolithic|modular|unclear"
}`,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: `Analyse this input:\n\n${input}` }]
    });

    const extracted = parseJSON(message.content[0].text);
    res.json({ success: true, data: extracted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── STAGE 2: QUESTIONS ────────────────────────────────────────────────────
app.post('/api/questions', async (req, res) => {
  const { extraction } = req.body;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: [
        {
          type: 'text',
          text: `You are an AI agent scoping assistant for Leancrest. Generate targeted clarifying questions based on an initial extraction.

${PLATFORM_CONSTRAINTS}

Generate 8–12 questions in this sequence:
1. Platform confirmation (Copilot Studio + Azure assumed — confirm or correct)
2. Use case confirmation and priority order
3. Document types (inputs the agent will receive)
4. Output format (what the agent produces)
5. Performance constraints (volume, response time, token budget)
6. Naming conventions (client prefix for files, e.g. "bbb")
7. Environment (Leancrest-run or client-run?)
8. Any gaps specific to the extracted ambiguities

Return ONLY a valid JSON array — no markdown, no explanation:
[
  {
    "id": "q1",
    "question": "string — clear, specific, one question only",
    "type": "text|select|multiselect",
    "options": ["array if select or multiselect, omit otherwise"],
    "required": true,
    "hint": "short helper text (max 15 words)"
  }
]`,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{
        role: 'user',
        content: `Generate clarifying questions based on this extraction:\n\n${JSON.stringify(extraction, null, 2)}`
      }]
    });

    const questions = parseJSON(message.content[0].text);
    res.json({ success: true, questions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── STAGE 3: SCOPING DOCUMENT (streaming) ─────────────────────────────────
app.post('/api/scope', async (req, res) => {
  const { extraction, questions, answers } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const qaContext = (questions || [])
      .map(q => `**${q.question}**\nAnswer: ${answers?.[q.id] || 'Not provided'}`)
      .join('\n\n');

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: [
        {
          type: 'text',
          text: `You are a senior AI consultant at Leancrest generating a professional scoping document for client sign-off.

${PLATFORM_CONSTRAINTS}

Generate the document in this exact structure:

---
# [Project Name] — Agent Scoping Document
**Prepared by:** Leancrest
**Client:** [Client Name]
**Date:** [Today's date]
**Version:** v1.0
**Status:** DRAFT — AWAITING SIGN-OFF
---

## 1. Purpose
One paragraph — what this agent does and why it exists.

## 2. Stakeholders
Table: Name | Role | Involvement

## 3. Use Cases
Numbered list. For each: description, input, expected output.

## 4. Input Documents
Types, sources, approximate volume.

## 5. Output Format
What the agent produces, format, length, style.

## 6. Platform & Constraints
- Platform: Microsoft Copilot Studio + Azure Prompt Library
- All known constraints (character limits, Responsible AI rules, SharePoint mode)
- Any performance constraints

## 7. Recommended Architecture
Monolithic or modular — with clear rationale referencing use case count and complexity.

## 8. Open Items
Table: # | Question | Owner | Priority

## 9. Sign-Off

| Role | Name | Date | Approved |
|---|---|---|---|
| Technical Lead | | | |
| Client Sponsor | | | |

---
*[Project Name] Scoping Document v1.0 · Leancrest · Confidential*

Style: Professional British English. No Oxford commas. Evidence-based statements only. No vague qualifiers.`,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{
        role: 'user',
        content: `Generate the scoping document using this information:

## Extraction
${JSON.stringify(extraction, null, 2)}

## Q&A Responses
${qaContext}`
      }]
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ─── STAGE 4: ARCHITECTURE RECOMMENDATION ──────────────────────────────────
app.post('/api/architecture', async (req, res) => {
  const { extraction, answers, questions } = req.body;

  try {
    const useCaseCount = extraction.useCases?.length || 0;
    const qaContext = (questions || [])
      .map(q => `${q.question}: ${answers?.[q.id] || 'N/A'}`)
      .join(' | ');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: [
        {
          type: 'text',
          text: `You are an AI architecture advisor for Leancrest recommending prompt architecture for Microsoft Copilot Studio + Azure Prompt Library deployments.

${PLATFORM_CONSTRAINTS}

Decision rules (from BBB project experience):
- 1–2 use cases, simple output → MONOLITHIC: one Copilot Instructions file handles everything
- 3+ use cases OR complex output OR distinct personas → MODULAR: Copilot Instructions as router + Azure prompts for each use case
- Always consider the 8,000-char Copilot Instructions limit — monolithic breaks down when content exceeds this
- Never put drafting logic in Copilot Instructions if modular — it is a router only

Return ONLY valid JSON — no markdown, no explanation:
{
  "recommendation": "monolithic|modular",
  "promptCount": "total number of files (1 if monolithic, N+1 if modular where N = azure prompts)",
  "promptNames": ["array of suggested azure prompt names if modular, empty if monolithic"],
  "rationale": "2–3 sentence explanation referencing use case count and complexity",
  "warnings": ["array of BBB-style warnings to flag, empty array if none"],
  "filePrefix": "lowercase client prefix for filenames, e.g. bbb",
  "fileNamingConvention": "e.g. bbb-[function]-v1.0.md"
}`,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{
        role: 'user',
        content: `Recommend architecture:

Client: ${extraction.clientName}
Use case count: ${useCaseCount}
Use cases: ${extraction.useCases?.join(', ')}
Complexity: ${extraction.complexityScore}
Architecture hint from input: ${extraction.architectureHint}
Q&A context: ${qaContext}`
      }]
    });

    const architecture = parseJSON(message.content[0].text);
    res.json({ success: true, architecture });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── STAGE 5: GENERATE PROMPT (streaming) ──────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { session, promptType, promptName, promptIndex } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const isCopilot = promptType === 'copilot-instructions';
  const { extraction, architecture, scopingDoc, questions, answers } = session;
  const qaContext = (questions || [])
    .map(q => `${q.question}: ${answers?.[q.id] || 'N/A'}`)
    .join('\n');

  const feedbackBank = await loadFeedbackBank();
  const relevantFeedback = feedbackBank
    .filter(e => !e.promptType || e.promptType === promptType)
    .slice(-20);
  const feedbackContext = relevantFeedback.length
    ? `\n\n## Logged Issues From Previous Sessions — Avoid These Patterns\n${relevantFeedback.map(e =>
        `- [${e.promptType || 'general'}] ${e.issue}${e.detail ? ': ' + e.detail : ''}${e.tags?.length ? ' (' + e.tags.join(', ') + ')' : ''}`
      ).join('\n')}`
    : '';

  const systemText = isCopilot
    ? `You are a Microsoft Copilot Studio specialist for Leancrest generating a Copilot Instructions file.

${PLATFORM_CONSTRAINTS}

CRITICAL RULES FOR COPILOT INSTRUCTIONS:
- HARD LIMIT: 8,000 characters total (whitespace included). Count carefully.
- Language: NEVER use MANDATORY, PROHIBITED, "Do NOT", "must not". Use: "The assistant provides...", "When X, the assistant returns Y"
- Output format: markdown only — never JSON
- If modular architecture: this file is the ROUTER only — all drafting logic lives in Azure prompts
- Include: role definition, operation-to-prompt routing table (if modular), SharePoint search strategy, error handling, next-step suggestions
- SharePoint: FederatedKnowledgeSearchOperation only — make this explicit
- File naming: ${architecture?.filePrefix || 'client'}-copilot-instructions-v1.0.md`
    : `You are an Azure Prompt Library specialist for Leancrest generating a standalone Azure prompt file.

${PLATFORM_CONSTRAINTS}

RULES FOR AZURE PROMPTS:
- Professional, non-imperative tone throughout
- Output format: markdown, not JSON
- Structure each file as: purpose header → input parameters → processing logic → output specification → constraint notes → version history block
- Be specific: no vague routing language, no placeholders — flag missing information explicitly
- British English, no Oxford commas
- Include a version history table at the bottom: v1.0 | [date] | Initial version
- File naming: ${architecture?.fileNamingConvention || '[client]-[function]-v1.0.md'}${feedbackContext}`;

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `Generate the ${isCopilot ? 'Copilot Instructions file' : `Azure prompt: "${promptName}"`}.

CLIENT: ${extraction?.clientName}
ARCHITECTURE: ${architecture?.recommendation} — ${architecture?.promptCount} file(s) total
${isCopilot && architecture?.recommendation === 'modular'
  ? `AZURE PROMPTS IN SYSTEM:\n${architecture?.promptNames?.map((n, i) => `- ${n}`).join('\n')}`
  : ''}
${!isCopilot
  ? `THIS PROMPT'S ROLE: ${promptName} (Azure prompt ${promptIndex} of ${(architecture?.promptNames?.length || 1)})`
  : ''}
USE CASES: ${extraction?.useCases?.join(', ')}
DOCUMENT TYPES: ${extraction?.documentTypes?.join(', ')}

SCOPING DOCUMENT SUMMARY:
${scopingDoc?.substring(0, 2000)}

Q&A CONTEXT:
${qaContext}`
      }]
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

// ─── STAGE 6: CHANGE TRACKER ───────────────────────────────────────────────
app.post('/api/tracker', async (req, res) => {
  const { session } = req.body;
  const { extraction, architecture, generatedPrompts } = session;
  const clientName = extraction?.clientName || 'Unknown Client';
  const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 5000,
      system: [
        {
          type: 'text',
          text: `You are generating an HTML change tracker document in the Leancrest BBB project style.

Use this exact CSS and layout pattern:
- Fonts: IBM Plex Sans (body), IBM Plex Mono (code/filenames) from Google Fonts
- Colours: --bg: #f7f6f3; --surface: #ffffff; --border: #e2e0da; --text: #1a1917; --text-muted: #6b6860; --accent: #1a3a5c; --accent-light: #e8eef5; --green: #1e7e47; --green-bg: #f0faf4; --orange: #d35400; --orange-bg: #fef5ee; --red: #c0392b;
- Dark blue header (#1a3a5c) with white text
- Clean tables, subtle borders, status badges
- Professional, minimal, no gratuitous decoration

Sections to include:
1. Header: session date, client, version v1.0, status COMPLETE
2. Artefacts Produced: table — Filename | Type | Description | Status (Complete badge)
3. Architecture Decision: recommendation + rationale
4. Platform Constraints Applied: which BBB rules were enforced
5. Key Decisions: bulleted list of decisions made in this session
6. Use Cases Addressed: table
7. Open Items: any remaining questions (or "None — all items resolved")
8. Footer: "Generated by LC Prompt Studio v1.0 · Leancrest · Confidential"

Return ONLY the complete HTML document. No markdown fences, no explanation, no text before or after the DOCTYPE.`,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{
        role: 'user',
        content: `Generate the change tracker HTML:

CLIENT: ${clientName}
DATE: ${dateStr}
ARCHITECTURE: ${architecture?.recommendation} (${architecture?.promptCount} file(s))
RATIONALE: ${architecture?.rationale}
FILE PREFIX: ${architecture?.filePrefix}

ARTEFACTS GENERATED:
${[
  `${architecture?.filePrefix || 'client'}-scoping-v1.0.md | Scoping Document | Requirements, architecture, sign-off gate`,
  ...(generatedPrompts || []).map(p => `${p.filename} | ${p.type} | ${p.description}`)
].join('\n')}

USE CASES:
${extraction?.useCases?.join('\n')}

WARNINGS FLAGGED:
${architecture?.warnings?.join('\n') || 'None'}

OPEN ITEMS:
${JSON.stringify(extraction?.ambiguities || [])}`
      }]
    });

    res.json({ success: true, html: message.content[0].text });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PACKAGE: ZIP DOWNLOAD ─────────────────────────────────────────────────
app.post('/api/package', async (req, res) => {
  const { session } = req.body;
  const prefix = (session.extraction?.clientName || 'client')
    .toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const dateStr = new Date().toISOString().split('T')[0];

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${prefix}-deployment-package-${dateStr}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);

  if (session.scopingDoc) {
    archive.append(session.scopingDoc, { name: `${prefix}-scoping-v1.0.md` });
  }

  for (const prompt of (session.generatedPrompts || [])) {
    archive.append(prompt.content, { name: prompt.filename });
  }

  if (session.trackerHtml) {
    archive.append(session.trackerHtml, { name: `${prefix}-change-tracker-v1.0.html` });
  }

  const manifest = generateManifest(session, prefix, dateStr);
  archive.append(manifest, { name: 'MANIFEST.md' });

  await archive.finalize();
});

function generateManifest(session, prefix, dateStr) {
  const { extraction, architecture, generatedPrompts } = session;
  const rows = [
    session.scopingDoc ? `| ${prefix}-scoping-v1.0.md | Scoping Document | Client sign-off gate |` : null,
    ...(generatedPrompts || []).map(p => `| ${p.filename} | ${p.type} | ${p.description} |`),
    session.trackerHtml ? `| ${prefix}-change-tracker-v1.0.html | Change Tracker | Session decisions log |` : null,
    `| MANIFEST.md | Manifest | This file |`
  ].filter(Boolean);

  return `# ${prefix} — Deployment Package Manifest
Generated: ${dateStr}
Version: 1.0

## Contents

| File | Type | Description |
|---|---|---|
${rows.join('\n')}

## Deployment Notes

- Architecture: ${architecture?.recommendation}
- Platform: Microsoft Copilot Studio + Azure Prompt Library
- All prompts versioned at v1.0
- **Sign-off required** on scoping document before deploying any prompts
- SharePoint mode: FederatedKnowledgeSearchOperation (RAG-only)
${architecture?.warnings?.length ? `\n## Warnings\n${architecture.warnings.map(w => `- ${w}`).join('\n')}` : ''}

---
*LC Prompt Studio v1.0 · Leancrest · ${dateStr}*
`;
}

// ─── SESSION ENDPOINTS ─────────────────────────────────────────────────────

app.post('/api/session/save', async (req, res) => {
  try {
    const { session, stage } = req.body;
    const id = `${Date.now()}-${(session.extraction?.clientName || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    const record = {
      id,
      date: new Date().toISOString(),
      clientName: session.extraction?.clientName || 'Unknown',
      projectName: session.extraction?.projectName || null,
      stage,
      session
    };
    await kvSet(`session:${id}`, record);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const keys = await kvKeys('session:*');
    const sessions = await Promise.all(keys.map(async k => {
      const d = await kvGet(k);
      return d ? { id: d.id, date: d.date, clientName: d.clientName, projectName: d.projectName, stage: d.stage } : null;
    }));
    const valid = sessions.filter(Boolean).sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ success: true, sessions: valid });
  } catch { res.json({ success: true, sessions: [] }); }
});

app.get('/api/session/:id', async (req, res) => {
  try {
    const data = await kvGet(`session:${req.params.id}`);
    if (!data) return res.status(404).json({ success: false, error: 'Session not found' });
    res.json({ success: true, data });
  } catch { res.status(404).json({ success: false, error: 'Session not found' }); }
});

app.delete('/api/session/:id', async (req, res) => {
  try {
    await kvDel(`session:${req.params.id}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── FEEDBACK BANK ENDPOINTS ───────────────────────────────────────────────

app.get('/api/feedback', async (req, res) => {
  res.json({ success: true, feedback: await loadFeedbackBank() });
});

app.post('/api/feedback', async (req, res) => {
  try {
    const { entry } = req.body;
    const bank = await loadFeedbackBank();
    const newEntry = { id: crypto.randomUUID(), date: new Date().toISOString(), ...entry };
    bank.push(newEntry);
    await kvSet('feedback-bank', bank);
    res.json({ success: true, entry: newEntry });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/feedback/:id', async (req, res) => {
  try {
    const bank = await loadFeedbackBank();
    await kvSet('feedback-bank', bank.filter(e => e.id !== req.params.id));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ============================================
// NEW ENDPOINTS FOR ENHANCED WORKFLOW
// ============================================

// Save use case ranking to Vercel KV
app.post('/api/save-ranking', async (req, res) => {
  try {
    const { sessionId, projectName, rankedUseCases, clarifyAnswers } = req.body;
    
    const rankingData = {
      sessionId,
      projectName,
      timestamp: Date.now(),
      rankedUseCases,
      clarifyAnswers
    };
    
    // Store the ranking
    await kvSet(`ranking:${sessionId}`, rankingData);
    
    // Add to list for retrieval (only if KV is available)
    if (USE_KV) {
      await kvLpush('all-rankings', sessionId);
    }
    
    res.json({ success: true, kvAvailable: USE_KV });
  } catch (error) {
    console.error('Error saving ranking:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Retrieve all saved rankings
app.get('/api/get-rankings', async (req, res) => {
  try {
    let rankings = [];
    
    if (USE_KV) {
      const sessionIds = await kvLrange('all-rankings', 0, -1);
      rankings = await Promise.all(
        sessionIds.map(async id => {
          const data = await kvGet(`ranking:${id}`);
          return data || null;
        })
      );
    } else {
      // In-memory fallback
      rankings = _localRankings;
    }
    
    res.json({ 
      rankings: rankings.filter(Boolean),
      kvAvailable: USE_KV 
    });
  } catch (error) {
    console.error('Error retrieving rankings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate success criteria (streaming)
app.post('/api/generate-success-criteria', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  try {
    const { scope, useCases } = req.body;
    
    const systemPrompt = `You are generating success criteria and testing outcomes for an AI agent deployment.

Based on the provided scope document and ranked use cases, generate:

1. SUCCESS CRITERIA (5-8 measurable criteria)
   - Each criterion must be specific and measurable
   - Include performance targets (time, accuracy, completeness)
   - Cover functional and non-functional requirements
   - Format: "Agent must [action] within [constraint]"
   
   Example:
   - IC Paper generation completes in under 45 seconds for standard cases
   - Zero fabricated citations in generated content
   - All applicable appendices generated with explicit data availability flags

2. TESTING OUTCOMES (5-8 testable scenarios)
   - Each outcome describes a complete user journey
   - Include expected inputs and outputs
   - Cover happy path and edge cases
   - Format: "User can [action] and system [responds]"
   
   Example:
   - User provides 3 SharePoint documents → generates Section 1 with citations
   - User requests missing appendix → system flags absent data correctly
   - User uploads malformed DDQ → system identifies parsing errors

OUTPUT FORMAT (markdown):
## Success Criteria

1. [Criterion 1]
2. [Criterion 2]
...

## Testing Outcomes

1. [Outcome 1]
2. [Outcome 2]
...`;

    const userPrompt = `# Project Scope\n\n${scope}\n\n# Ranked Use Cases\n\n${useCases.map((uc, i) => `${i + 1}. ${uc.text || uc}`).join('\n')}`;

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Error generating success criteria:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

// Generate architecture recommendation with pros/cons (streaming)
app.post('/api/generate-architecture-analysis', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  try {
    const { scope, useCases, successCriteria, testingOutcomes } = req.body;
    
    const systemPrompt = `You are recommending an architectural approach for an AI agent deployment.

Based on the provided scope, success criteria, and use cases, provide:

1. ARCHITECTURAL RECOMMENDATION (2-3 paragraphs)
   - Recommend either monolithic or modular approach
   - Explain reasoning based on complexity, timeout risk, maintainability
   - Reference success criteria and testing outcomes

2. MONOLITHIC APPROACH ANALYSIS
   Pros:
   - [3-5 specific advantages]
   
   Cons:
   - [3-5 specific disadvantages]
   
   When to use:
   - [1-2 sentences describing ideal use cases]

3. MODULAR APPROACH ANALYSIS
   Pros:
   - [3-5 specific advantages]
   
   Cons:
   - [3-5 specific disadvantages]
   
   When to use:
   - [1-2 sentences describing ideal use cases]

4. FILE STRUCTURE RECOMMENDATION
   List all prompt files to be generated:
   - copilot-instructions (REQUIRED)
   - ic-paper-template (if applicable)
   - [component-specific files]
   
   For each file include:
   - Name
   - Purpose (1 sentence)
   - Estimated token count

OUTPUT FORMAT (markdown with clear sections using ## headings)`;

    const userPrompt = `# Project Scope\n\n${scope}\n\n# Use Cases\n\n${useCases.map((uc, i) => `${i + 1}. ${uc.text || uc}`).join('\n')}\n\n# Success Criteria\n\n${successCriteria.join('\n')}\n\n# Testing Outcomes\n\n${testingOutcomes.join('\n')}`;

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 6000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Error generating architecture:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  }
});

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`LC Prompt Studio running at http://localhost:${PORT}`));
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', kv: USE_KV ? 'available' : 'local-fallback' });
});

module.exports = app;