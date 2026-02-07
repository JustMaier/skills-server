// Full end-to-end test: create agent → grant permissions → list → load → execute
const BASE = 'http://localhost:3000';
const ADMIN_KEY = 'sk-admin-957570843034cca5ec4a8f086eadbde6';

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

console.log('\n=== Full E2E Agent Workflow ===\n');

// Step 1: Create agent
let agentId, agentKey;
await test('1. Create agent', async () => {
  const { status, json } = await api('POST', '/api/v1/agents', { name: 'e2e-agent' }, ADMIN_KEY);
  assert(status === 201 || status === 200, `status ${status}`);
  agentId = json.id;
  agentKey = json.apiKey;
  console.log(`     Agent ID: ${agentId}`);
  console.log(`     Agent Key: ${agentKey}`);
});

// Step 2: Create env var
let envVarId;
await test('2. Create env var', async () => {
  const { status, json } = await api('POST', '/api/v1/env-vars', {
    key: 'GREETING',
    value: 'Hello from env!',
    description: 'Test greeting',
  }, ADMIN_KEY);
  assert(status === 201 || status === 200, `status ${status}`);
  envVarId = json.id;
  console.log(`     Env Var ID: ${envVarId}`);
});

// Step 3: Get skill ID from admin API (we need to add this to the API - for now check the response)
let skillDbId;
await test('3. Find hello skill in admin list', async () => {
  // The admin skills list doesn't expose DB IDs. We need to use the reload response
  // or find another way. Let's check what fields are returned.
  const { status, json } = await api('GET', '/api/v1/admin/skills', null, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  const hello = json.skills.find(s => s.name === 'hello');
  assert(hello, 'hello skill not found');
  console.log(`     Skills found: ${json.skills.map(s => s.name).join(', ')}`);

  // Since admin API doesn't return skill IDs, we need to use the reverse lookup
  // or modify the API. For now let's try the agents by-skill route to get the ID.
  // Actually, for permissions we need the skill DB UUID.
  // Let's check if the bulk set endpoint can accept skill names...
  // No, it expects skillIds.

  // Workaround: We know the skill exists in the DB. Let's try using the reverse lookup
  // to see if it exposes the skill ID indirectly, or check if there's a skills list
  // in the DB we can query.

  // Actually the simplest fix: the skills admin list SHOULD return IDs.
  // This is an ergonomics issue to note for the review.
  // For now, let's look at the DB directly.
});

// Workaround: query skills DB to get the ID
// Since we don't have a direct API for this, let's try the agentsBySkill endpoint
// which queries by name. If we can get the skill row...

// Actually, I realize we can use the permissions PUT endpoint which expects skillIds.
// But we don't have the ID. Let's try an alternative approach:
// Use the incremental POST /:id/skills/:skillId endpoint.
// We need to know the skill ID. The reverse-lookup GET /skills/:name/agents works
// by looking up the skill by name, so internally it has the ID.

// Let's just get the DB id by using a workaround test:
await test('4. Get skill DB ID (via direct query workaround)', async () => {
  // The OpenAPI spec should list the paths. Let's check the reverse-lookup
  // to understand if there's an ID we can use.
  // Actually, since we can't easily get the ID, let's test with the bulk permissions API
  // and accept that this is an API gap to fix.

  // For the test, let's use a node sqlite3 query
  const Database = (await import('better-sqlite3')).default;
  const dbFile = new URL('./skills-server.db', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  const sqliteDb = new Database(dbFile, { readonly: true });
  const row = sqliteDb.prepare("SELECT id FROM skills WHERE name = 'hello'").get();
  sqliteDb.close();
  assert(row, 'hello skill not in DB');
  skillDbId = row.id;
  console.log(`     Skill DB ID: ${skillDbId}`);
});

// Step 5: Grant skill to agent
await test('5. Grant hello skill to agent (incremental)', async () => {
  const { status } = await api('POST', `/api/v1/agents/${agentId}/skills/${skillDbId}`, {}, ADMIN_KEY);
  assert(status === 204 || status === 200, `status ${status}`);
});

// Step 6: Grant env var to agent
await test('6. Grant GREETING env var to agent', async () => {
  const { status } = await api('POST', `/api/v1/agents/${agentId}/env-vars/${envVarId}`, {}, ADMIN_KEY);
  assert(status === 204 || status === 200, `status ${status}`);
});

// Step 7: Verify permissions
await test('7. Verify agent permissions', async () => {
  const { status, json } = await api('GET', `/api/v1/agents/${agentId}/permissions`, null, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  assert(json.skills.length === 1, `expected 1 skill, got ${json.skills.length}`);
  assert(json.skills[0].name === 'hello', `wrong skill: ${json.skills[0].name}`);
  assert(json.envVars.length === 1, `expected 1 env var, got ${json.envVars.length}`);
  assert(json.envVars[0].key === 'GREETING', `wrong key: ${json.envVars[0].key}`);
});

// Step 8: Agent lists skills (should see hello now)
await test('8. Agent lists available skills', async () => {
  const { status, json } = await api('GET', '/api/v1/skills', null, agentKey);
  assert(status === 200, `status ${status}`);
  assert(json.length === 1, `expected 1 skill, got ${json.length}`);
  assert(json[0].name === 'hello', `wrong skill: ${json[0].name}`);
  assert(Array.isArray(json[0].scripts), 'no scripts array');
  console.log(`     Skills: ${json.map(s => s.name).join(', ')}`);
  console.log(`     Scripts: ${json[0].scripts.join(', ')}`);
});

// Step 9: Agent loads skill content
await test('9. Agent loads hello skill content', async () => {
  const { status, json } = await api('GET', '/api/v1/skills/hello', null, agentKey);
  assert(status === 200, `status ${status}`);
  assert(json.name === 'hello', 'wrong name');
  assert(json.content, 'no content');
  assert(json.content.includes('hello'), 'content missing hello');
  console.log(`     Content length: ${json.content.length} chars`);
});

// Step 10: Agent executes hello skill
await test('10. Agent executes hello skill', async () => {
  const { status, json } = await api('POST', '/api/v1/skills/hello/execute', {
    script: 'hello.mjs',
    args: ['world', 'test'],
  }, agentKey);
  assert(status === 200, `status ${status}: ${JSON.stringify(json)}`);
  assert(json.success === true, `not successful: ${JSON.stringify(json)}`);
  assert(json.stdout, 'no stdout');
  console.log(`     stdout: ${json.stdout.trim()}`);
  console.log(`     exitCode: ${json.exitCode}`);
  console.log(`     durationMs: ${json.durationMs}`);
});

// Step 11: Check execution log
await test('11. Execution logged', async () => {
  const { status, json } = await api('GET', '/api/v1/execution-logs', null, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  assert(json.length >= 1, 'no logs');
  const log = json[0];
  assert(log.skillName === 'hello', `wrong skill: ${log.skillName}`);
  assert(log.script === 'hello.mjs', `wrong script: ${log.script}`);
  console.log(`     Log ID: ${log.id}`);
  console.log(`     Agent: ${log.agentName}`);
});

// Step 12: Reverse lookup - which agents have hello skill
await test('12. Reverse lookup: agents with hello skill', async () => {
  const { status, json } = await api('GET', '/api/v1/agents/skills/hello/agents', null, ADMIN_KEY);
  assert(status === 200, `status ${status}`);
  assert(json.length === 1, `expected 1 agent, got ${json.length}`);
  assert(json[0].name === 'e2e-agent', `wrong name: ${json[0].name}`);
});

// Step 13: Revoke skill
await test('13. Revoke hello skill', async () => {
  const { status } = await api('DELETE', `/api/v1/agents/${agentId}/skills/${skillDbId}`, null, ADMIN_KEY);
  assert(status === 204 || status === 200, `status ${status}`);
});

// Step 14: Agent can no longer see hello skill
await test('14. Agent no longer sees hello skill', async () => {
  const { status, json } = await api('GET', '/api/v1/skills', null, agentKey);
  assert(status === 200, `status ${status}`);
  assert(json.length === 0, `expected 0 skills, got ${json.length}`);
});

// Step 15: Agent cannot execute revoked skill
await test('15. Agent cannot execute revoked skill', async () => {
  const { status } = await api('POST', '/api/v1/skills/hello/execute', {
    script: 'hello.mjs',
    args: [],
  }, agentKey);
  assert(status === 403, `expected 403, got ${status}`);
});

// Cleanup
await test('16. Delete agent (cascades permissions)', async () => {
  const { status } = await api('DELETE', `/api/v1/agents/${agentId}`, null, ADMIN_KEY);
  assert(status === 200 || status === 204, `status ${status}`);
});

await test('17. Delete env var', async () => {
  const { status } = await api('DELETE', `/api/v1/env-vars/${envVarId}`, null, ADMIN_KEY);
  assert(status === 200 || status === 204, `status ${status}`);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
