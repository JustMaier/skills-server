// Quick end-to-end API test script
const BASE = 'http://localhost:3000';
const ADMIN_KEY = 'sk-admin-957570843034cca5ec4a8f086eadbde6';

let agentId = null;
let agentKey = null;
let skillId = null;
let envVarId = null;
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, text };
}

console.log('\n=== Skills Server API Tests ===\n');

// --- OpenAPI ---
console.log('-- OpenAPI --');
await test('GET /api/v1/openapi.json returns spec', async () => {
  const { status, json } = await api('GET', '/api/v1/openapi.json');
  assert(status === 200, `status ${status}`);
  assert(json.openapi === '3.1.0', 'wrong openapi version');
  assert(json.info.title === 'Skills Server', 'wrong title');
});

// --- Auth rejection ---
console.log('-- Auth --');
await test('Admin route rejects without token', async () => {
  const { status } = await api('GET', '/api/v1/agents');
  assert(status === 401, `expected 401, got ${status}`);
});

await test('Admin route rejects with bad token', async () => {
  const { status } = await api('GET', '/api/v1/agents', null, 'bad-key');
  assert(status === 401, `expected 401, got ${status}`);
});

// --- Agents CRUD ---
console.log('-- Agents --');
await test('POST /api/v1/agents creates agent', async () => {
  const { status, json } = await api('POST', '/api/v1/agents', { name: 'test-agent' }, ADMIN_KEY);
  assert(status === 201 || status === 200, `status ${status}: ${JSON.stringify(json)}`);
  assert(json.id, 'no id');
  assert(json.apiKey, 'no apiKey returned');
  assert(json.apiKey.startsWith('sk-agent-'), `bad key prefix: ${json.apiKey}`);
  agentId = json.id;
  agentKey = json.apiKey;
});

await test('GET /api/v1/agents lists agents', async () => {
  const { status, json } = await api('GET', '/api/v1/agents', null, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  assert(Array.isArray(json), 'not array');
  assert(json.length >= 1, 'empty list');
  assert(!json[0].apiKeyHash, 'apiKeyHash leaked');
});

await test('GET /api/v1/agents/:id gets agent', async () => {
  const { status, json } = await api('GET', `/api/v1/agents/${agentId}`, null, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  assert(json.name === 'test-agent', `wrong name: ${json.name}`);
});

await test('PATCH /api/v1/agents/:id updates agent', async () => {
  const { status, json } = await api('PATCH', `/api/v1/agents/${agentId}`, { name: 'renamed-agent' }, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  assert(json.name === 'renamed-agent', `wrong name: ${json.name}`);
});

await test('POST /api/v1/agents/:id/rotate rotates key', async () => {
  const { status, json } = await api('POST', `/api/v1/agents/${agentId}/rotate`, {}, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  assert(json.apiKey, 'no new apiKey');
  agentKey = json.apiKey;
});

// --- Env Vars CRUD ---
console.log('-- Env Vars --');
await test('POST /api/v1/env-vars creates var', async () => {
  const { status, json } = await api('POST', '/api/v1/env-vars', {
    key: 'TEST_SECRET',
    value: 'my-secret-value',
    description: 'A test secret',
  }, ADMIN_KEY);
  assert(status === 201 || status === 200, `status ${status}: ${JSON.stringify(json)}`);
  assert(json.id, 'no id');
  envVarId = json.id;
});

await test('GET /api/v1/env-vars lists vars (no values)', async () => {
  const { status, json } = await api('GET', '/api/v1/env-vars', null, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  assert(Array.isArray(json), 'not array');
  const item = json.find(v => v.key === 'TEST_SECRET');
  assert(item, 'TEST_SECRET not found');
  assert(!item.encryptedValue, 'encrypted value leaked');
  assert(!item.value, 'plaintext value leaked');
});

// --- Skills Admin ---
console.log('-- Skills Admin --');
await test('GET /api/v1/admin/skills lists skills', async () => {
  const { status, json } = await api('GET', '/api/v1/admin/skills', null, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  assert(json.skills, 'no skills field');
  assert(json.skills.length >= 1, 'no skills');
  const hello = json.skills.find(s => s.name === 'hello');
  assert(hello, 'hello skill not found');
  // Save skill ID from the DB for permissions
});

// Look up skill ID from DB via admin skills list (we need the DB id)
await test('POST /api/v1/admin/skills/reload reloads', async () => {
  const { status, json } = await api('POST', '/api/v1/admin/skills/reload', {}, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  assert(typeof json.total === 'number', 'no total');
});

// --- Permissions ---
console.log('-- Permissions --');

// First, we need the skill's DB id. Let's get it from the DB via a workaround.
// The skills admin endpoint doesn't return IDs, so let's check what's available.
// We need to use the agents route to grant by skill ID.
// Actually looking at permissions routes, PUT /:id/skills expects { skillIds: [...] }
// and POST /:id/skills/:skillId expects the skill's DB id.
// Let's look at how agent-facing routes work to understand.

// The agent-facing routes use skill name, not ID. But permissions need skill IDs.
// Let's check if the admin skills list returns IDs...
{
  const { json } = await api('GET', '/api/v1/admin/skills', null, ADMIN_KEY);
  // The schema only returns name, description, scripts, parseError, updatedAt — no ID!
  // We need to get the skill ID some other way. Let's check the agents by skill reverse lookup.
  // Actually, the permissions bulk route takes skillIds. We need the DB IDs.
  // For testing, let's query the DB directly via the execution to find skill IDs.
  // OR we can look at what the permissions route expects...
}

// Get skills from the DB - we'll need to use the skills list to find IDs
// Since the admin API doesn't expose skill IDs, let's check via agentsBySkill
// Actually, let's check if there's a way to get skill IDs...
// For now, let's test incremental grant by skill name if that's the API.
// Let me re-read the permissions routes...

// Looking at the summary: PUT /:id/skills takes { skillIds: [...] }
// POST /:id/skills/:skillId takes a skill ID in the URL
// We need a skill ID. Let me try to get it.

// Workaround: The skills table has unique names, so in a real app the admin UI
// would fetch skill IDs. For testing, we'll need to find another way.
// Let's test what we can without the skill ID.

await test('GET /api/v1/agents/:id/permissions returns empty', async () => {
  const { status, json } = await api('GET', `/api/v1/agents/${agentId}/permissions`, null, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  assert(json.skills, 'no skills');
  assert(json.envVars, 'no envVars');
  assert(json.skills.length === 0, 'should have no skills');
});

// --- Agent-facing (no permissions yet) ---
console.log('-- Agent-Facing (before permissions) --');
await test('Agent can list skills (empty - no permissions)', async () => {
  const { status, json } = await api('GET', '/api/v1/skills', null, agentKey);
  assert(status === 200, `status ${status}`);
  assert(Array.isArray(json), 'not array');
  // Should be empty since no skills granted
  assert(json.length === 0, `expected 0 skills, got ${json.length}`);
});

// --- Grant skill to agent ---
// To grant, we need the skill DB id. Let's try to extract it.
// The execution_logs endpoint won't help. Let's try to use the OpenAPI spec
// or query a different way.
// Actually, since skills-admin doesn't expose IDs, this is a gap we should note.
// For testing purposes, let's use the DB directly via a quick query.

// Actually, re-reading the reverse-lookup route:
// GET /skills/:name/agents — this takes a skill NAME and returns agents
// This suggests skills are often referenced by name in the URL.
// But PUT /:id/skills expects { skillIds: [...] } — which are DB UUIDs.
// This is an ergonomics issue to flag in the review.

// For now, let's test the full flow by doing a workaround:
// The reload endpoint syncs skills to DB and the admin list shows them.
// We just need to add an ID field to the admin skills list.
// For this test, let's try posting with an empty/guess ID and see what happens.

// Alternative: Query the skills via the agents/skills/:name/agents reverse route.
// If we try to look up "hello" skill agents, it should work if the skill exists in DB.
await test('GET agents by skill name works', async () => {
  const { status, json } = await api('GET', `/api/v1/agents/skills/hello/agents`, null, ADMIN_KEY);
  assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
  assert(Array.isArray(json), 'not array');
});

// Since we can't easily get skill IDs from the API, let's note this
// and test agent auth + skill.md download + execution log listing.

// --- Static files ---
console.log('-- Static --');
await test('GET /api/v1/skill.md serves skill doc', async () => {
  const res = await fetch(`${BASE}/api/v1/skill.md`);
  assert(res.status === 200, `status ${res.status}`);
  const text = await res.text();
  assert(text.includes('skills-server'), 'missing skills-server mention');
});

await test('GET / serves index.html', async () => {
  const res = await fetch(`${BASE}/`);
  assert(res.status === 200, `status ${res.status}`);
  const text = await res.text();
  assert(text.includes('<!DOCTYPE html>'), 'not HTML');
});

// --- Execution Logs ---
console.log('-- Execution Logs --');
await test('GET /api/v1/execution-logs returns array', async () => {
  const { status, json } = await api('GET', '/api/v1/execution-logs', null, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  assert(Array.isArray(json), 'not array');
});

// --- Cleanup ---
console.log('-- Cleanup --');
await test('DELETE /api/v1/agents/:id deletes agent', async () => {
  const { status } = await api('DELETE', `/api/v1/agents/${agentId}`, null, ADMIN_KEY);
  assert(status === 200 || status === 204, `status ${status}`);
});

await test('DELETE /api/v1/env-vars/:id deletes var', async () => {
  const { status } = await api('DELETE', `/api/v1/env-vars/${envVarId}`, null, ADMIN_KEY);
  assert(status === 200 || status === 204, `status ${status}`);
});

// --- Summary ---
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
