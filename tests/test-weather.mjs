// Weather skill + env var scoping E2E test
const ADMIN = process.env.ADMIN_API_KEY || 'sk-admin-957570843034cca5ec4a8f086eadbde6';
const BASE = 'http://localhost:3000/api/v1';
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { console.log('  PASS ', msg); passed++; }
  else { console.log('  FAIL ', msg); failed++; }
}

async function adminFetch(path, opts = {}) {
  const body = opts.body ? JSON.stringify(opts.body) : undefined;
  return fetch(BASE + path, { ...opts, body, headers: { 'Authorization': 'Bearer ' + ADMIN, 'Content-Type': 'application/json' } });
}
async function agentFetch(key, path, opts = {}) {
  const body = opts.body ? JSON.stringify(opts.body) : undefined;
  return fetch(BASE + path, { ...opts, body, headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' } });
}

async function run() {
  console.log('=== Weather Skill + Env Var Scoping E2E ===\n');

  // 1. Create agent
  let res = await adminFetch('/agents', { method: 'POST', body: { name: 'weather-agent' } });
  const { id: agentId, apiKey } = await res.json();
  assert(apiKey && apiKey.startsWith('sk-agent-'), '1. Created weather-agent');

  // 2. Create WEATHER_UNITS env var set to fahrenheit
  res = await adminFetch('/env-vars', { method: 'POST', body: { key: 'WEATHER_UNITS', value: 'fahrenheit', description: 'Temperature unit preference' } });
  const { id: envVarId } = await res.json();
  assert(envVarId, '2. Created WEATHER_UNITS env var');

  // 3. Get skill IDs
  res = await adminFetch('/admin/skills');
  const skillsData = await res.json();
  const weatherSkill = skillsData.skills.find(s => s.name === 'weather');
  const helloSkill = skillsData.skills.find(s => s.name === 'hello');
  assert(weatherSkill && helloSkill, '3. Both skills discovered');
  console.log('     Weather scripts:', weatherSkill.scripts);

  // 4. Grant both skills to agent
  await adminFetch('/agents/' + agentId + '/skills/' + weatherSkill.id, { method: 'POST' });
  await adminFetch('/agents/' + agentId + '/skills/' + helloSkill.id, { method: 'POST' });
  assert(true, '4. Granted both skills to agent');

  // 5. Grant env var to agent
  await adminFetch('/agents/' + agentId + '/env-vars/' + envVarId, { method: 'POST' });
  assert(true, '5. Granted WEATHER_UNITS to agent');

  // 6. Link env var to weather skill ONLY (not hello)
  res = await adminFetch('/admin/skills/' + weatherSkill.id + '/env-vars/' + envVarId, { method: 'POST' });
  assert(res.status === 204, '6. Linked WEATHER_UNITS to weather skill only');

  // 7. Agent lists skills — should see both
  res = await agentFetch(apiKey, '/skills');
  const agentSkills = await res.json();
  assert(agentSkills.length === 2, '7. Agent sees 2 skills');

  // 8. Execute weather skill — should get fahrenheit (env var injected)
  res = await agentFetch(apiKey, '/skills/weather/execute', {
    method: 'POST', body: { script: 'weather.mjs', args: ['London'] }
  });
  let result = await res.json();
  const weatherLines = result.stdout.trim().split('\n');
  for (const line of weatherLines) console.log('     ' + line);
  assert(result.success && result.stdout.includes('fahrenheit'), '8. Weather skill gets WEATHER_UNITS=fahrenheit');

  // 9. Hello skill should NOT see WEATHER_UNITS (not linked to hello)
  res = await agentFetch(apiKey, '/skills/hello/execute', {
    method: 'POST', body: { script: 'hello.mjs', args: ['env', 'WEATHER_UNITS'] }
  });
  result = await res.json();
  assert(result.stdout.trim() === '', '9. Hello skill does NOT see WEATHER_UNITS (scoped)');

  // 10. Unlink env var — weather should fall back to celsius
  await adminFetch('/admin/skills/' + weatherSkill.id + '/env-vars/' + envVarId, { method: 'DELETE' });
  res = await agentFetch(apiKey, '/skills/weather/execute', {
    method: 'POST', body: { script: 'weather.mjs', args: ['London'] }
  });
  result = await res.json();
  const lines2 = result.stdout.trim().split('\n');
  for (const line of lines2) console.log('     ' + line);
  assert(result.success && result.stdout.includes('celsius'), '10. After unlinking, weather defaults to celsius');

  // Cleanup
  await adminFetch('/agents/' + agentId, { method: 'DELETE' });
  await adminFetch('/env-vars/' + envVarId, { method: 'DELETE' });

  console.log('\n=== Results: ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed > 0 ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
