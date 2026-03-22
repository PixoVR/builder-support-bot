import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const response = await client.models.list();
    return res.status(200).json(response.data.map(m => m.id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
