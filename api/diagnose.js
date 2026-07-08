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

// Block 1: role + method + docs. Stable across ALL calls -> globally cacheable.
const INSTRUCTIONS = (docs) => `You are Builder Doctor, chatting with an author about their Pixo Builder book — a no-code tool for interactive XR training. They describe what's going wrong in their own words; you figure out why by reading the book's wiring, and you either explain it or tell them to bring it to Pixo Support.

You are given, in a separate context block, the CURRENT BOOK CONTEXT: the chapter under discussion (with its GUID and the time the file was last saved), a deterministic scan for known bugs, and a WIRING DIGEST of that chapter's authored logic (Sparks with their Causes and Effects, what each is wired to, and key trait values). Treat that as the state of their book as of the save time — you cannot see unsaved edits open in Builder.

How to converse:
- Be warm, brief, and plain. Talk like a knowledgeable colleague, not a form. No preamble like "Great question."
- The user has already been shown which chapter and save-time you're looking at, so don't recite it unless it becomes relevant (e.g. their description doesn't match the chapter provided — then say so and ask them to confirm the chapter).
- If you need something to diagnose — what they expected, which object, which chapter — just ask, one question at a time.
- When you diagnose, point to the specific Sparks/nodes in the WIRING DIGEST as evidence (e.g. "the Interacted cause on the door is wired to Highlight, not Move" or "the '≠3' output of If Is Equal To Value isn't connected, so the loop can't continue"). Ground every claim about how Builder behaves in the DOCUMENTATION below — never invent Builder behavior.
- Each effect in the digest has a "reachedFrom" list: the entry points (Causes, or triggers the runtime fires on its own like "Chapter Started") that reach it through the wiring — possibly through several intermediate nodes wired in series. BEFORE you say a node is never triggered, never called, or "nothing kicks it off", check its reachedFrom: if it is non-empty, the node IS triggered — do not claim otherwise, and do not suggest adding a trigger that already exists. Only call something untriggered when its reachedFrom is empty. Wiring often runs through a chain, so a node can be triggered by "Chapter Started" without being wired to it directly.
- When you propose a fix, give the single correct change and stop. Do not offer a menu of alternative wirings unless you are certain every alternative is also correct — a plausible-but-wrong option is worse than none. Reason through what a suggested wire would actually do before you state it. In particular, with loops: the loop must pass through its exit condition on every iteration, so never suggest a path that loops back BEFORE the check that ends the loop (that bypasses the termination condition and never stops). If you're not sure an alternative is safe, leave it out.
- If a KNOWN ISSUE matches, name it (with its identifier) and give the workaround. Known bugs are not the user's fault.
- If the authoring looks correct and no known issue matches, say so plainly and suggest they bring it to Pixo Support with their .pixob and Player.log — do NOT invent a user-error explanation. When you're genuinely unsure, lean toward that honest escalation rather than a confident guess.

PIXO BUILDER DOCUMENTATION:
${docs}`;

// Block 2: this book's context. Stable across the turns of one conversation -> per-conversation cacheable.
function bookContext({ bookMap, chapter, knownIssues = [], log, digest }) {
  return [
    `CURRENT BOOK CONTEXT (the user's uploaded file):`,
    `  Book: ${bookMap?.name || '(unknown)'}`,
    `  Chapter under discussion: ${chapter?.name || '(unspecified)'} [${(chapter?.guid || '').slice(0, 8)}]`,
    `  File last saved: ${bookMap?.savedAt || '(unknown)'}`,
    ``,
    `KNOWN ISSUES (deterministic scan): ${knownIssues.length ? '' : 'none matched'}`,
    knownIssues.length ? JSON.stringify(knownIssues, null, 1) : '',
    log ? `\nPLAYER.LOG (excerpt):\n${String(log).slice(0, 6000)}` : '',
    ``,
    `WIRING DIGEST (authored logic of this chapter):`,
    '```json',
    JSON.stringify(digest || {}).slice(0, 90000),
    '```',
  ].join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Anthropic-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages = [], digest, bookMap, chapter, knownIssues = [], log, userName } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'messages is required' });
  if (!digest) return res.status(400).json({ error: 'digest is required (parse the .pixob client-side first)' });

  // Key seam: bring-your-own-key via header, else the shared server key.
  const apiKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No Anthropic API key configured.' });
  const client = new Anthropic({ apiKey });

  let docs;
  try { docs = loadDocs(); } catch (err) { return res.status(500).json({ error: err.message }); }

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: [
        // Stable across all calls -> cached globally.
        { type: 'text', text: INSTRUCTIONS(docs), cache_control: { type: 'ephemeral' } },
        // Stable across turns of THIS conversation -> cached per-conversation.
        { type: 'text', text: bookContext({ bookMap, chapter, knownIssues, log, digest }), cache_control: { type: 'ephemeral' } },
      ],
      messages: messages.slice(-12), // keep recent turns
    });
    const u = response.usage || {};
    console.log(`cache: ${u.cache_creation_input_tokens || 0} created, ${u.cache_read_input_tokens || 0} read / ${u.input_tokens || 0} uncached input`);
    const answer = response.content[0].text;
    logToSheets({ timestamp: new Date().toISOString(), userName: userName || 'anonymous', mode: 'diagnose', chapter: chapter?.name, lastUser: messages[messages.length - 1]?.content, answer });
    return res.status(200).json({ answer });
  } catch (err) {
    console.error('Claude API error:', err.message);
    return res.status(500).json({ error: 'Failed to get a diagnosis. Please try again.' });
  }
}
