import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouter } from '@openrouter/sdk';
import {
  createSkillsProvider,
  createSdkTools,
  createManualTools,
  toToolResult,
} from '../dist/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT ?? 3001;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SKILLS_SERVER_URL = process.env.SKILLS_SERVER_URL;
const SKILLS_SERVER_API_KEY = process.env.SKILLS_SERVER_API_KEY;
const DEFAULT_MODEL = process.env.MODEL ?? 'anthropic/claude-sonnet-4';

// Models available in the UI dropdown
const MODELS = [
  'stepfun/step-3.5-flash:free',
  'x-ai/grok-4.1-fast',
  'openai/gpt-5-nano',
  'openai/gpt-oss-120b:free',
  'openai/gpt-oss-20b:free',
  'arcee-ai/trinity-large-preview:free',
  'z-ai/glm-4.7-flash',
  'xiaomi/mimo-v2-flash',
  'nvidia/nemotron-3-nano-30b-a3b',
];

if (!OPENROUTER_API_KEY) {
  console.error(
    'Missing OPENROUTER_API_KEY. Copy .env.example to .env and set your key.',
  );
  process.exit(1);
}

if (!SKILLS_SERVER_URL || !SKILLS_SERVER_API_KEY) {
  console.error(
    'Missing SKILLS_SERVER_URL or SKILLS_SERVER_API_KEY. Copy .env.example to .env and set your values.',
  );
  process.exit(1);
}

// --- Skills setup (remote server) ---

const skills = await createSkillsProvider(
  SKILLS_SERVER_URL,
  SKILLS_SERVER_API_KEY,
);
console.log(`Connected to skills server at ${SKILLS_SERVER_URL}`);
console.log(`Available skills: ${skills.skillNames.join(', ') || '(none)'}`);

// Manual tools (execute: false) — we run tools ourselves between turns for real streaming
const manualTools = createManualTools(createSdkTools(skills));

const client = new OpenRouter({ apiKey: OPENROUTER_API_KEY });

// --- Sessions (in-memory conversation history) ---

const sessions = new Map(); // sessionId -> messages[]

function getSession(id) {
  if (!id || !sessions.has(id)) {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, []);
    return { sessionId, messages: sessions.get(sessionId) };
  }
  return { sessionId: id, messages: sessions.get(id) };
}

// --- MIME types ---

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// --- Static file serving ---

async function serveStatic(req, res) {
  const url = req.url === '/' ? '/index.html' : req.url;
  const publicDir = resolve(join(__dirname, 'public'));
  const filePath = resolve(join(publicDir, url));

  // Prevent path traversal
  if (!filePath.startsWith(publicDir + sep) && filePath !== publicDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('Not a file');

    const content = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// --- Helpers ---

function sse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// --- Chat API endpoint — manual multi-turn loop for real streaming ---

async function handleChat(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const userMessage = payload.message?.trim();
  const model = payload.model || DEFAULT_MODEL;

  if (!userMessage) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No message provided' }));
    return;
  }

  const { sessionId, messages } = getSession(payload.sessionId);
  messages.push({ role: 'user', content: userMessage });

  console.log(
    `[chat] session=${sessionId.slice(0, 8)} model=${model} messages=${messages.length}`,
  );

  // SSE response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders();
  res.socket?.setNoDelay?.(true);

  sse(res, { type: 'session', sessionId });

  try {
    let instructions =
      'You are a helpful assistant with access to skills.\n' +
      'When the user asks you to do something covered by a skill, load it first, then use it.\n\n' +
      skills.skillsCatalog;

    // Turn-local items (tool calls/results for this request only)
    const turnItems = [];
    let finalText = '';
    const MAX_STEPS = 10;

    for (let step = 0; step < MAX_STEPS; step++) {
      const result = client.callModel({
        model,
        instructions,
        input: [...messages, ...turnItems],
        tools: manualTools,
      });

      // Stream text deltas from this single turn
      let turnText = '';
      for await (const delta of result.getTextStream()) {
        turnText += delta;
        sse(res, { type: 'text_delta', delta });
      }

      // Get the full response to check for tool calls
      const response = await result.getResponse();
      const toolCalls = (response.output ?? []).filter(
        (o) => o.type === 'function_call',
      );

      if (toolCalls.length === 0) {
        // No tool calls — model produced a text response, we're done
        finalText =
          turnText ||
          response.output
            ?.filter((o) => o.type === 'message')
            .flatMap((o) => o.content ?? [])
            .filter((p) => p.type === 'output_text')
            .map((p) => p.text)
            .join('') ||
          '';
        break;
      }

      // Process each tool call: execute, stream events, build history
      for (const tc of toolCalls) {
        const name = tc.name;
        const args = JSON.parse(tc.arguments ?? '{}');
        const callId = tc.callId ?? tc.id;

        sse(res, { type: 'tool_call', name, arguments: tc.arguments });

        // Execute the tool via the remote provider
        const execResult = await skills.handleToolCall(name, args);
        const toolResult = toToolResult(execResult);

        sse(res, {
          type: 'tool_result',
          name,
          result: JSON.stringify(toolResult),
        });

        // Handle instruction injection for load_skill (replaces nextTurnParams)
        if (name === 'load_skill' && execResult.success) {
          const marker = `[Skill: ${args.skill}]`;
          if (!instructions.includes(marker)) {
            instructions += `\n\n${marker}\n${execResult.stdout}`;
          }
        }

        // Add tool call + result to turn history for the next callModel turn
        turnItems.push({
          type: 'function_call',
          callId,
          name,
          arguments: tc.arguments,
        });
        turnItems.push({
          type: 'function_call_output',
          callId,
          output: JSON.stringify(toolResult),
        });
      }
    }

    // Send authoritative full text + done
    sse(res, { type: 'content', content: finalText });
    sse(res, { type: 'done' });

    // Persist to session: only remembered tool calls + final assistant message
    for (const item of turnItems) {
      if (item.type === 'function_call') {
        try {
          const args = JSON.parse(item.arguments ?? '{}');
          // Always keep load_skill; only keep use_skill when remember: true
          if (item.name === 'load_skill' || args.remember === true) {
            messages.push(item);
          }
        } catch {
          /* skip */
        }
      } else if (item.type === 'function_call_output') {
        // Keep output if its corresponding call was kept
        const prevMsg = messages[messages.length - 1];
        if (
          prevMsg?.type === 'function_call' &&
          prevMsg.callId === item.callId
        ) {
          messages.push(item);
        }
      }
    }
    if (finalText) {
      messages.push({ role: 'assistant', content: finalText });
    }
  } catch (err) {
    sse(res, { type: 'error', error: err.message });
  }

  res.end();
}

// --- Server ---

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    await handleChat(req, res);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/config') {
    // Refresh skills on page load / new chat so new permissions appear immediately
    try { await skills.refresh(); } catch { /* best-effort */ }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        defaultModel: DEFAULT_MODEL,
        models: MODELS,
        skills: skills.skillNames,
      }),
    );
    return;
  }

  if (req.method === 'GET') {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`Example app running at http://localhost:${PORT}`);
});
