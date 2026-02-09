/**
 * Chat server example using the Claude Agent SDK with skills server integration.
 *
 * Prerequisites:
 *   1. Build the package: npm run build (from packages/client-agent-sdk)
 *   2. Start the skills server
 *   3. Copy .env.example to .env and set your values
 *
 * Run:
 *   node --env-file=.env server.mjs
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createSkillsServerConfig } from '../dist/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT ?? 3002;
const SKILLS_SERVER_URL = process.env.SKILLS_SERVER_URL;
const SKILLS_SERVER_API_KEY = process.env.SKILLS_SERVER_API_KEY;

if (!SKILLS_SERVER_URL || !SKILLS_SERVER_API_KEY) {
  console.error(
    'Missing SKILLS_SERVER_URL or SKILLS_SERVER_API_KEY.\n' +
      'Copy .env.example to .env and set your values.',
  );
  process.exit(1);
}

// --- Skills server MCP config ---

const skillsConfig = await createSkillsServerConfig(
  SKILLS_SERVER_URL,
  SKILLS_SERVER_API_KEY,
);

console.log(`Skills server: ${SKILLS_SERVER_URL}`);
console.log(`Available skills: ${skillsConfig.client.skills.map(s => s.name).join(', ') || '(none)'}`);

// --- Sessions (in-memory, keyed by Agent SDK session ID) ---

const sessions = new Map(); // sessionId -> { sdkSessionId }

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

// --- Chat API endpoint ---

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
  if (!userMessage) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No message provided' }));
    return;
  }

  // Look up existing SDK session for resume, or start fresh
  const clientSessionId = payload.sessionId ?? null;
  const existingSession = clientSessionId
    ? sessions.get(clientSessionId)
    : null;
  const sdkResumeId = existingSession?.sdkSessionId ?? undefined;

  console.log(
    `[chat] client=${clientSessionId?.slice(0, 8) ?? 'new'} resume=${sdkResumeId?.slice(0, 8) ?? 'none'} msg="${userMessage.slice(0, 60)}"`,
  );

  // SSE response headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders();
  res.socket?.setNoDelay?.(true);

  try {
    // Build query options
    const options = {
      ...skillsConfig,
      maxTurns: 10,
      includePartialMessages: true,
    };

    // Resume existing session if available
    if (sdkResumeId) {
      options.resume = sdkResumeId;
    }

    let sdkSessionId = sdkResumeId;
    let currentToolName = null;
    let currentToolInput = '';
    let assistantText = '';

    for await (const message of query({ prompt: userMessage, options })) {
      // Capture session ID from any message
      if (message.session_id && !sdkSessionId) {
        sdkSessionId = message.session_id;
      }

      // --- Stream events (partial messages) ---
      if (message.type === 'stream_event') {
        const event = message.event;

        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            currentToolName = event.content_block.name;
            currentToolInput = '';
            sse(res, {
              type: 'tool_start',
              name: currentToolName,
            });
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta') {
            assistantText += delta.text;
            sse(res, { type: 'text_delta', delta: delta.text });
          } else if (delta?.type === 'input_json_delta') {
            currentToolInput += delta.partial_json ?? '';
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolName) {
            sse(res, {
              type: 'tool_call',
              name: currentToolName,
              arguments: currentToolInput,
            });
            currentToolName = null;
            currentToolInput = '';
          }
        }
      }

      // --- Complete assistant message (after streaming finishes) ---
      if (message.type === 'assistant') {
        // Extract tool results from the message content
        for (const block of message.message.content) {
          if (block.type === 'tool_result') {
            const resultText =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .filter((c) => c.type === 'text')
                      .map((c) => c.text)
                      .join('')
                  : JSON.stringify(block.content);

            sse(res, {
              type: 'tool_result',
              name: block.tool_use_id ?? 'unknown',
              result: resultText,
            });
          }
        }
      }

      // --- Final result ---
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          sse(res, { type: 'content', content: assistantText });
        } else if (message.subtype === 'error') {
          sse(res, {
            type: 'error',
            error: message.error ?? 'Agent returned an error',
          });
        }
      }
    }

    // Persist session mapping
    if (sdkSessionId) {
      const sessionKey = clientSessionId ?? sdkSessionId;
      sessions.set(sessionKey, { sdkSessionId });
      sse(res, { type: 'session', sessionId: sessionKey });
    }

    sse(res, { type: 'done' });
  } catch (err) {
    console.error('[chat] Error:', err);
    sse(res, { type: 'error', error: err.message ?? 'Unknown error' });
  }

  res.end();
}

// --- Config endpoint ---

async function handleConfig(req, res) {
  // Refresh skills on page load so new permissions appear immediately
  try { await skillsConfig.client.refresh(); } catch { /* best-effort */ }

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(
    JSON.stringify({
      skills: skillsConfig.client.skills.map(s => s.name),
    }),
  );
}

// --- HTTP server ---

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
    handleConfig(req, res);
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
  console.log(`Chat server running at http://localhost:${PORT}`);
});
