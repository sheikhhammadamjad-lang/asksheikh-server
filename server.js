const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({ windowMs: 24 * 60 * 60 * 1000, max: 20, message: { error: 'You have reached your daily limit of 20 questions. Please come back tomorrow!' } });
app.use('/chat', limiter);

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const BASE = 'https://asksheikh1-resource.services.ai.azure.com/api/projects/asksheikh';
const AGENT_ID = 'AskSheikh';
const VER = 'api-version=2025-05-01';

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  const fetch = (await import('node-fetch')).default;
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://ai.azure.com/.default'
  });

  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) throw new Error(`Token failed: ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function authHeaders(token) {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const userMessage = messages[messages.length - 1].content;
    const fetch = (await import('node-fetch')).default;
    const token = await getToken();

    // Step 1: Create thread
    const threadRes = await fetch(`${BASE}/threads?${VER}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: '{}'
    });
    if (!threadRes.ok) throw new Error(`Thread failed: ${await threadRes.text()}`);
    const thread = await threadRes.json();
    const threadId = thread.id;

    // Step 2: Add message
    const msgRes = await fetch(`${BASE}/threads/${threadId}/messages?${VER}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ role: 'user', content: userMessage })
    });
    if (!msgRes.ok) throw new Error(`Message failed: ${await msgRes.text()}`);

    // Step 3: Run agent
    const runRes = await fetch(`${BASE}/threads/${threadId}/runs?${VER}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ assistant_id: AGENT_ID })
    });
    if (!runRes.ok) throw new Error(`Run failed: ${await runRes.text()}`);
    const run = await runRes.json();
    const runId = run.id;

    // Step 4: Poll for completion
    let status = 'queued';
    let attempts = 0;
    while (!['completed', 'failed', 'cancelled'].includes(status) && attempts < 40) {
      await new Promise(r => setTimeout(r, 1500));
      const statusRes = await fetch(`${BASE}/threads/${threadId}/runs/${runId}?${VER}`, { headers: authHeaders(token) });
      const statusData = await statusRes.json();
      status = statusData.status;
      attempts++;
    }

    if (status !== 'completed') throw new Error(`Run did not complete: ${status}`);

    // Step 5: Get reply
    const msgsRes = await fetch(`${BASE}/threads/${threadId}/messages?${VER}&order=desc&limit=5`, { headers: authHeaders(token) });
    if (!msgsRes.ok) throw new Error(`Get messages failed`);
    const msgsData = await msgsRes.json();
    const assistantMsg = msgsData.data.find(m => m.role === 'assistant');

    let reply = '';
    if (assistantMsg && assistantMsg.content) {
      for (const c of assistantMsg.content) {
        if (c.type === 'text') reply += c.text?.value || '';
      }
    }

    // Remove citation markers like 【4:0†source】
    reply = reply.replace(/【[^】]*】/g, '').trim();

    console.log('User:', userMessage);
    console.log('Sheikh:', reply.substring(0, 150) + '...');

    res.json({
      choices: [{
        message: { content: reply, role: 'assistant' },
        finish_reason: 'stop'
      }]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT, () => console.log('Running'));
