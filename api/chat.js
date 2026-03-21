import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

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
    // Non-fatal — logging failure shouldn't break the chat response
    console.error('Sheets logging failed:', err.message);
  }
}

export default async function handler(req, res) {
  // CORS headers
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

  // Build Gemini chat history (all turns except the latest question)
  const history = conversationHistory.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-lite',
      systemInstruction: systemPrompt,
    });

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(question.trim());
    const answer = result.response.text();

    // Log asynchronously — don't await, don't block response
    logToSheets({
      timestamp: new Date().toISOString(),
      userName: userName || 'anonymous',
      question: question.trim(),
      answer,
    });

    return res.status(200).json({ answer });
  } catch (err) {
    console.error('Gemini API error:', err.message);
    return res.status(500).json({ error: 'Failed to get a response. Please try again.', debug: err.message });
  }
}
