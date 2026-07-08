import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

// Reasoning-heavy diagnosis. Swap to a stronger model here if calibration needs it.
const MODEL = 'claude-sonnet-4-6';

// Docs grounding (same bundle the support chat uses), cached across warm invocations.
let docsContext = null;
function loadDocs() {
  if (docsContext) return docsContext;
  const docsPath = path.join(process.cwd(), 'data', 'docs.json');
  if (!fs.existsSync(docsPath)) throw new Error('data/docs.json not found. Run: npm run bundle-docs');
  const docs = JSON.parse(fs.readFileSync(docsPath, 'utf8'));
  docsContext = docs.map(d => `## ${d.title}\n\n${d.content}`).join('\n\n---\n\n');
  return docsContext;
}

async function logToSheets(payload) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (err) { console.error('Sheets logging failed:', err.message); }
}

const SYSTEM = (docs) => `You are Builder Doctor, a diagnostic assistant for Pixo Builder — a no-code authoring tool for interactive XR training. An author tells you what they expected to happen and what actually happened; you reason over the wiring of their book to explain why, or tell them to escalate.

You are given, per request:
- BOOK IDENTITY: the book name, the specific chapter under diagnosis (by GUID), and the time the file was last saved.
- WIRING DIGEST: the relevant chapter's Sparks with their Causes and Effects and what each is wired to, plus key trait values. This is the authored logic.
- KNOWN ISSUES: any matches from a deterministic scan of the book against a catalog of confirmed Builder bugs.
- The Pixo Builder DOCUMENTATION, which defines how Sparks, Causes, Effects, traits, and wiring behave.

HOW TO REASON:
1. Anchor on identity. Begin by stating which chapter (name + short GUID) and that you are reading the file "as of last save at <time>" — you cannot see unsaved edits open in Builder. If the user's description seems to describe a different chapter than the one provided, say so and ask them to confirm rather than guessing.
2. If a KNOWN ISSUE matches the symptom, name it (with its identifier) and give its workaround. Known bugs are not the user's fault.
3. Otherwise compare EXPECTED vs ACTUAL against the WIRING DIGEST. Point to the specific Sparks/nodes and wiring that explain the gap (e.g. "the Interacted cause on X is wired to Highlight, not Move" or "the '≠3' output of If Is Equal To Value is not connected, so the loop can't continue"). Cite node names from the digest as evidence. Ground every claim about how Builder behaves in the DOCUMENTATION — never invent Builder behavior.
4. If the authoring looks correct and no known issue matches, DO NOT invent a user-error explanation. Say the authoring looks correct and that this may be a Builder issue, and tell them to bring it to Pixo Support with their .pixob and Player.log. When genuinely unsure, bias toward escalating rather than toward a confident guess — a wrong-but-confident answer is worse than an honest escalation.

Be concrete and brief. Structure: what you're looking at (identity) → the cause (with wiring evidence) or escalation → the fix (if it's authoring). Do not pad.

PIXO BUILDER DOCUMENTATION:
${docs}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { expected, actual, chapter, digest, bookMap, knownIssues = [], log, userName } = req.body || {};
  if (!expected || !actual) return res.status(400).json({ error: 'expected and actual are both required' });
  if (!digest) return res.status(400).json({ error: 'digest is required (parse the .pixob client-side first)' });

  // Key seam: bring-your-own-key via header, else the shared server key.
  const apiKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No Anthropic API key configured.' });
  const client = new Anthropic({ apiKey });

  let docs;
  try { docs = loadDocs(); } catch (err) { return res.status(500).json({ error: err.message }); }

  const userContent = [
    `BOOK IDENTITY:`,
    `  Book: ${bookMap?.name || '(unknown)'}`,
    `  Chapter under diagnosis: ${chapter?.name || '(unspecified)'} [${(chapter?.guid || '').slice(0, 8)}]`,
    `  File last saved: ${bookMap?.savedAt || '(unknown — treat as the version the user just uploaded)'}`,
    ``,
    `EXPECTED: ${expected}`,
    `ACTUAL: ${actual}`,
    ``,
    `KNOWN ISSUES (deterministic scan):`,
    knownIssues.length ? JSON.stringify(knownIssues, null, 1) : '  (none matched)',
    ``,
    log ? `PLAYER.LOG (excerpt):\n${String(log).slice(0, 6000)}\n` : '',
    `WIRING DIGEST (authored logic of the chapter):`,
    '```json',
    JSON.stringify(digest).slice(0, 90000),
    '```',
  ].join('\n');

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      // Cache the docs-bearing system prompt (stable across calls) to cut repeat input cost ~10x.
      system: [{ type: 'text', text: SYSTEM(docs), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    });
    const u = response.usage || {};
    console.log(`cache: ${u.cache_creation_input_tokens || 0} created, ${u.cache_read_input_tokens || 0} read / ${u.input_tokens || 0} uncached input`);
    const answer = response.content[0].text;
    logToSheets({ timestamp: new Date().toISOString(), userName: userName || 'anonymous', mode: 'diagnose', expected, actual, chapter: chapter?.name, answer });
    return res.status(200).json({ answer });
  } catch (err) {
    console.error('Claude API error:', err.message);
    return res.status(500).json({ error: 'Failed to get a diagnosis. Please try again.' });
  }
}
