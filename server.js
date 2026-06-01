const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs/promises');
const path = require('path');
const app = express();

app.set('trust proxy', 1);
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 20,
  message: { error: 'You have reached your daily limit of 20 questions. Please come back tomorrow!' }
});
app.use('/chat', limiter);

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const FOUNDRY_BASE = process.env.AZURE_FOUNDRY_BASE || 'https://asksheikh1-resource.services.ai.azure.com/api/projects/asksheikh';
const FOUNDRY_API_VERSION = process.env.AZURE_FOUNDRY_API_VERSION || '2025-05-01';
const AGENT_ID = process.env.AZURE_FOUNDRY_AGENT_ID || '11cd40fc-b1b3-457f-a453-0cc4922e0459';
const LOG_DIR = path.join(__dirname, 'logs');

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
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function appendJsonLog(fileName, entry) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(
    path.join(LOG_DIR, fileName),
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`
  );
}

function cleanReply(text) {
  return (text || '').replace(/【[^】]*】/g, '').trim();
}

function extractAssistantText(assistantMsg) {
  let reply = '';
  if (assistantMsg?.content) {
    for (const item of assistantMsg.content) {
      if (item.type === 'text') reply += item.text?.value || item.text || '';
    }
  }
  return cleanReply(reply);
}

function conversationPrompt(messages) {
  const recent = messages.slice(-10);
  const transcript = recent.map(message => {
    const role = message.role === 'assistant' ? 'AskSheikh' : 'User';
    return `${role}: ${message.content}`;
  }).join('\n\n');

  return [
    'Continue this AskSheikh conversation. Use the agent instructions, knowledge base, and web search tools configured in Azure Foundry.',
    '',
    transcript
  ].join('\n');
}

async function callFoundryAgent(messages) {
  const fetch = (await import('node-fetch')).default;
  const token = await getToken();
  const qs = `api-version=${FOUNDRY_API_VERSION}`;

  const threadRes = await fetch(`${FOUNDRY_BASE}/threads?${qs}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: '{}'
  });
  if (!threadRes.ok) throw new Error(`Thread failed: ${await threadRes.text()}`);
  const thread = await threadRes.json();

  const msgRes = await fetch(`${FOUNDRY_BASE}/threads/${thread.id}/messages?${qs}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      role: 'user',
      content: conversationPrompt(messages)
    })
  });
  if (!msgRes.ok) throw new Error(`Message failed: ${await msgRes.text()}`);

  const runRes = await fetch(`${FOUNDRY_BASE}/threads/${thread.id}/runs?${qs}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ assistant_id: AGENT_ID })
  });
  if (!runRes.ok) throw new Error(`Run failed: ${await runRes.text()}`);
  const run = await runRes.json();

  let status = run.status || 'queued';
  let attempts = 0;
  while (!['completed', 'failed', 'cancelled', 'expired'].includes(status) && attempts < 60) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const statusRes = await fetch(`${FOUNDRY_BASE}/threads/${thread.id}/runs/${run.id}?${qs}`, {
      headers: authHeaders(token)
    });
    if (!statusRes.ok) throw new Error(`Run status failed: ${await statusRes.text()}`);
    const statusData = await statusRes.json();
    status = statusData.status;
    attempts++;
  }

  if (status !== 'completed') throw new Error(`Run did not complete: ${status}`);

  const msgsRes = await fetch(`${FOUNDRY_BASE}/threads/${thread.id}/messages?${qs}&order=desc&limit=10`, {
    headers: authHeaders(token)
  });
  if (!msgsRes.ok) throw new Error(`Get messages failed: ${await msgsRes.text()}`);
  const msgsData = await msgsRes.json();
  const assistantMsg = msgsData.data.find(message => message.role === 'assistant');

  return {
    reply: extractAssistantText(assistantMsg),
    threadId: thread.id,
    runId: run.id
  };
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.post('/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const userMessage = messages[messages.length - 1].content;
    const result = await callFoundryAgent(messages);

    await appendJsonLog('conversations.jsonl', {
      userMessage,
      mode: 'foundry_agent_proxy',
      assistantReply: result.reply,
      agentId: AGENT_ID,
      threadId: result.threadId,
      runId: result.runId
    });

    console.log('User:', userMessage);
    console.log('Foundry agent:', result.reply.substring(0, 150) + '...');

    res.json({
      choices: [{ message: { content: result.reply, role: 'assistant' }, finish_reason: 'stop' }],
      metadata: {
        mode: 'foundry_agent_proxy',
        agent_id: AGENT_ID,
        thread_id: result.threadId,
        run_id: result.runId
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
