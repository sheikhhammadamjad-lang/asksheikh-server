const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(require('express').static('public'));
const AZURE_API_KEY = process.env.AZURE_KEY;
const ENDPOINT = 'https://asksheikh1-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-12-01-preview';
const SYSTEM_PROMPT = 'You are Ask Sheikh — digital mentor powered by Sheikh Hammad Amjad (BizTherapist). 18+ years, 1000+ founders, 20+ countries. ACE framework: Authenticity, Commercial Viability, Execution. Commercial viability is dealbreaker. Max 3 paragraphs. No bullets. Conversational. Use Dekho... End with one next step. Book at biztherapist.biz';
app.get('/health', (req, res) => res.status(200).json({status:'ok'}));
app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': AZURE_API_KEY },
      body: JSON.stringify({ messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages], max_tokens: 600, temperature: 0.7 })
    });
    const data = await response.json();
    console.log('---CONVERSATION---');
console.log('User:', messages[messages.length-1].content);
console.log('Sheikh:', data.choices?.[0]?.message?.content);
console.log('---END---');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
app.listen(process.env.PORT || 3000, () => console.log('Running'));