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

const AZURE_OPENAI_ENDPOINT = (process.env.AZURE_OPENAI_ENDPOINT || 'https://asksheikh1-resource.openai.azure.com').replace(/\/$/, '');
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || 'gpt-4o';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';

const AZURE_SEARCH_ENDPOINT = (process.env.AZURE_SEARCH_ENDPOINT || process.env.AZURE_AI_SEARCH_ENDPOINT || '').replace(/\/$/, '');
const AZURE_SEARCH_INDEX = process.env.AZURE_SEARCH_INDEX || process.env.AZURE_SEARCH_INDEX_NAME || '';
const AZURE_SEARCH_API_KEY = process.env.AZURE_SEARCH_API_KEY || process.env.AZURE_AI_SEARCH_API_KEY;
const AZURE_SEARCH_API_VERSION = process.env.AZURE_SEARCH_API_VERSION || '2024-07-01';
const AZURE_SEARCH_SEMANTIC_CONFIG = process.env.AZURE_SEARCH_SEMANTIC_CONFIG || '';
const SEARCH_TOP_K = Number(process.env.AZURE_SEARCH_TOP_K) || 5;
const KB_MIN_SCORE = Number(process.env.KB_MIN_SCORE) || 1;

const CONTENT_FIELDS = (process.env.AZURE_SEARCH_CONTENT_FIELDS || 'content,chunk,text,pageContent,body')
  .split(',')
  .map(field => field.trim())
  .filter(Boolean);
const SOURCE_FIELDS = (process.env.AZURE_SEARCH_SOURCE_FIELDS || 'source,title,fileName,filename,metadata_storage_name,url')
  .split(',')
  .map(field => field.trim())
  .filter(Boolean);

const LOG_DIR = path.join(__dirname, 'logs');
const tokenCache = new Map();

async function getToken(scope) {
  const cached = tokenCache.get(scope);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(`Missing Azure service principal env vars for scope ${scope}`);
  }

  const fetch = (await import('node-fetch')).default;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope
  });

  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) throw new Error(`Azure token failed: ${await res.text()}`);
  const data = await res.json();
  tokenCache.set(scope, {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000
  });
  return data.access_token;
}

async function openAiHeaders() {
  if (AZURE_OPENAI_API_KEY) {
    return { 'Content-Type': 'application/json', 'api-key': AZURE_OPENAI_API_KEY };
  }

  const token = await getToken('https://cognitiveservices.azure.com/.default');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function searchHeaders() {
  if (AZURE_SEARCH_API_KEY) {
    return { 'Content-Type': 'application/json', 'api-key': AZURE_SEARCH_API_KEY };
  }

  const token = await getToken('https://search.azure.com/.default');
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

function pickField(doc, fields) {
  for (const field of fields) {
    if (doc[field]) return String(doc[field]);
  }
  return '';
}

function normalizeSearchDoc(doc) {
  const score = Number(doc['@search.rerankerScore'] || doc['@search.score'] || 0);
  const content = pickField(doc, CONTENT_FIELDS);
  const source = pickField(doc, SOURCE_FIELDS) || 'Sheikh KB';

  return {
    score,
    content,
    source,
    id: doc.id || doc.key || doc.chunk_id || doc.document_id || source
  };
}

function kbStrength(results) {
  if (!results.length) return 'missing';
  const usable = results.filter(item => item.content && item.content.length > 120);
  const topScore = results[0]?.score || 0;

  if (!usable.length) return 'missing';
  if (topScore >= KB_MIN_SCORE && usable.length >= 2) return 'strong';
  if (topScore >= KB_MIN_SCORE || usable.length >= 2) return 'medium';
  return 'weak';
}

async function searchSheikhKb(query) {
  if (!AZURE_SEARCH_ENDPOINT || !AZURE_SEARCH_INDEX) {
    throw new Error('Missing AZURE_SEARCH_ENDPOINT or AZURE_SEARCH_INDEX');
  }

  const fetch = (await import('node-fetch')).default;
  const body = {
    search: query,
    top: SEARCH_TOP_K,
    count: true
  };

  if (AZURE_SEARCH_SEMANTIC_CONFIG) {
    body.queryType = 'semantic';
    body.semanticConfiguration = AZURE_SEARCH_SEMANTIC_CONFIG;
    body.captions = 'extractive';
    body.answers = 'extractive|count-3';
  }

  const res = await fetch(
    `${AZURE_SEARCH_ENDPOINT}/indexes/${encodeURIComponent(AZURE_SEARCH_INDEX)}/docs/search?api-version=${AZURE_SEARCH_API_VERSION}`,
    {
      method: 'POST',
      headers: await searchHeaders(),
      body: JSON.stringify(body)
    }
  );

  if (!res.ok) throw new Error(`Azure Search failed: ${await res.text()}`);
  const data = await res.json();
  const results = (data.value || [])
    .map(normalizeSearchDoc)
    .filter(item => item.content)
    .sort((a, b) => b.score - a.score);

  return {
    results,
    strength: kbStrength(results),
    totalCount: data['@odata.count'] || results.length
  };
}

function formatKbContext(results) {
  return results.map((item, index) => {
    return [
      `SOURCE ${index + 1}: ${item.source}`,
      `SCORE: ${item.score}`,
      item.content
    ].join('\n');
  }).join('\n\n---\n\n');
}

function userApprovedExternal(messages, allowExternal) {
  if (allowExternal === true) return true;
  if (!Array.isArray(messages) || messages.length < 2) return false;

  const last = messages[messages.length - 1]?.content || '';
  const previousAssistant = [...messages]
    .reverse()
    .slice(1)
    .find(m => m.role === 'assistant')?.content || '';

  return /permission|external|general source|outside|general knowledge/i.test(previousAssistant) &&
    /^(yes|yeah|yep|ok|okay|sure|approved|go ahead|use external|use general)/i.test(last.trim());
}

function isGenericStartupOpener(message) {
  const text = String(message || '').trim().toLowerCase();
  return [
    'i have a startup idea',
    'i have an idea',
    'i have a business idea',
    'i want to start a startup',
    'i want to start a business',
    'startup idea',
    'business idea'
  ].includes(text);
}

function startupIdeaFollowUp() {
  return [
    "Good. Don't pitch it like a dream yet. Give me the raw version.",
    "",
    "Assess:",
    "What problem are you solving, and who feels that pain badly enough to pay or change behavior?",
    "",
    "Clarify:",
    "Send me four things:",
    "1. The customer",
    "2. The problem",
    "3. Your solution",
    "4. How you think it will make money",
    "",
    "Execute:",
    "Write it in 3-5 lines. Then I'll help you test if it is a real opportunity or just an interesting idea."
  ].join('\n');
}

async function askGpt(messages) {
  const fetch = (await import('node-fetch')).default;
  const url = `${AZURE_OPENAI_ENDPOINT}/openai/deployments/${encodeURIComponent(AZURE_OPENAI_DEPLOYMENT)}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: await openAiHeaders(),
    body: JSON.stringify({
      messages,
      temperature: 0.3,
      max_tokens: 900
    })
  });

  if (!res.ok) throw new Error(`Azure OpenAI chat failed: ${await res.text()}`);
  const data = await res.json();
  return cleanReply(data.choices?.[0]?.message?.content || '');
}

async function answerFromKb(userMessage, kbResults) {
  const context = formatKbContext(kbResults);
  return askGpt([
    {
      role: 'system',
      content: [
        "You are Sheikh, an AI startup mentor.",
        "Answer ONLY from the Sheikh KB context provided by Azure AI Search.",
        "Do not add web knowledge, general model knowledge, or facts not present in the context.",
        "If the context is not enough, say so briefly instead of guessing.",
        "Use Sheikh's ACE framework:",
        "Assess: diagnose the situation.",
        "Clarify: name the key choice or tradeoff.",
        "Execute: give the next practical move.",
        "Keep the tone direct, practical, and founder-friendly."
      ].join('\n')
    },
    {
      role: 'user',
      content: `Sheikh KB context:\n\n${context}\n\nUser question:\n${userMessage}`
    }
  ]);
}

async function answerFromGeneralKnowledge(userMessage) {
  return askGpt([
    {
      role: 'system',
      content: [
        "You are Sheikh, an AI startup mentor.",
        "The user gave permission to use general knowledge because the Sheikh KB was weak or missing.",
        "Clearly label the answer as using general knowledge, not Sheikh KB.",
        "Do not claim live web browsing.",
        "If facts may have changed, say they should be verified.",
        "Use Sheikh's ACE framework: Assess, Clarify, Execute.",
        "Keep the tone direct, practical, and founder-friendly."
      ].join('\n')
    },
    { role: 'user', content: userMessage }
  ]);
}

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.post('/chat', async (req, res) => {
  try {
    const { messages, allowExternal } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const userMessage = messages[messages.length - 1].content;
    const externalApproved = userApprovedExternal(messages, allowExternal);

    if (isGenericStartupOpener(userMessage)) {
      const reply = startupIdeaFollowUp();
      await appendJsonLog('conversations.jsonl', {
        userMessage,
        mode: 'startup_opener_followup',
        assistantReply: reply,
        sources: []
      });

      return res.json({
        choices: [{ message: { content: reply, role: 'assistant' }, finish_reason: 'stop' }],
        metadata: {
          mode: 'startup_opener_followup',
          kb_first: false,
          external_sources_used: false
        }
      });
    }

    if (externalApproved) {
      const reply = await answerFromGeneralKnowledge(userMessage);
      await appendJsonLog('conversations.jsonl', {
        userMessage,
        mode: 'external_approved',
        assistantReply: reply,
        sources: ['general_knowledge_user_approved']
      });

      return res.json({
        choices: [{ message: { content: reply, role: 'assistant' }, finish_reason: 'stop' }],
        metadata: {
          mode: 'external_approved',
          kb_first: false,
          external_sources_used: true
        }
      });
    }

    const kb = await searchSheikhKb(userMessage);
    const sourceSummary = kb.results.map(item => ({
      source: item.source,
      score: item.score,
      id: item.id
    }));

    if (['weak', 'missing'].includes(kb.strength)) {
      const knowledgeGap = kb.results.length
        ? `Azure AI Search found low-confidence matches. Top score: ${kb.results[0].score}.`
        : 'Azure AI Search found no matching Sheikh KB content.';
      const permissionPrompt = [
        "I don't have enough in Sheikh's knowledge base to answer this with confidence.",
        "",
        `Knowledge gap: ${knowledgeGap}`,
        "",
        "Do you want me to use general/external knowledge for this answer? If yes, I'll label it clearly and still frame it through Sheikh's ACE framework."
      ].join('\n');

      await appendJsonLog('knowledge-gaps.jsonl', {
        userMessage,
        kbConfidence: kb.strength,
        knowledgeGap,
        sources: sourceSummary
      });

      await appendJsonLog('conversations.jsonl', {
        userMessage,
        mode: 'kb_missing_permission_requested',
        assistantReply: permissionPrompt,
        kbConfidence: kb.strength,
        sources: sourceSummary
      });

      return res.json({
        choices: [{ message: { content: permissionPrompt, role: 'assistant' }, finish_reason: 'stop' }],
        metadata: {
          mode: 'kb_missing_permission_requested',
          kb_first: true,
          needs_external_permission: true,
          kb_confidence: kb.strength,
          sources: sourceSummary
        }
      });
    }

    const reply = await answerFromKb(userMessage, kb.results);
    await appendJsonLog('conversations.jsonl', {
      userMessage,
      mode: 'kb_answer',
      assistantReply: reply,
      kbConfidence: kb.strength,
      sources: sourceSummary
    });

    console.log('User:', userMessage);
    console.log('Sheikh mode:', 'kb_answer');
    console.log('Sheikh:', reply.substring(0, 150) + '...');

    res.json({
      choices: [{ message: { content: reply, role: 'assistant' }, finish_reason: 'stop' }],
      metadata: {
        mode: 'kb_answer',
        kb_first: true,
        external_sources_used: false,
        kb_confidence: kb.strength,
        sources: sourceSummary
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
