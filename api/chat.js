import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Load docs once at cold-start (cached across warm invocations)
let docsContext = null;

function loadDocs() {
  if (docsContext) return docsContext;

  const docsPath = path.join(process.cwd(), 'data', 'docs.json');
  if (!fs.existsSync(docsPath)) {
    throw new Error('data/docs.json not found. Run: npm run bundle-docs');
  }

  const docs = JSON.parse(fs.readFileSync(docsPath, 'utf8'));
  docsContext = docs
    .map(d => `## ${d.title}\n\n${d.content}`)
    .join('\n\n---\n\n');

  return docsContext;
}

async function logToSheets(payload) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('Sheets logging failed:', err.message);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { question, userName, conversationHistory = [] } = req.body;

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return res.status(400).json({ error: 'question is required' });
  }

  let docs;
  try {
    docs = loadDocs();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const systemPrompt = `You are a helpful support assistant for Pixo Builder — a no-code authoring tool for creating interactive XR (extended reality) training simulations. You help users understand how to use the Builder effectively.

Answer questions based strictly on the documentation provided below. Be concise and practical. When referencing specific features or UI elements, use the exact names from the docs.

If the answer isn't covered in the documentation, say so clearly — for example: "I don't have documentation on that yet. You may want to reach out to the Pixo team directly." Do not guess or invent behavior.

If a question is vague, ask a brief clarifying question before answering.

PIXO BUILDER DOCUMENTATION:
${docs}`;

  const messages = [
    ...conversationHistory,
    { role: 'user', content: question.trim() },
  ];

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const answer = response.content[0].text;

    logToSheets({
      timestamp: new Date().toISOString(),
      userName: userName || 'anonymous',
      question: question.trim(),
      answer,
    });

    return res.status(200).json({ answer });
  } catch (err) {
    console.error('Claude API error:', err.message);
    return res.status(500).json({ error: 'Failed to get a response. Please try again.' });
  }
}
