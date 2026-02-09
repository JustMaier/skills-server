/**
 * E2E setup: Create 3 test agents, grant them access to skills,
 * then output their API keys for client testing.
 */

const BASE = 'http://localhost:3000/api/v1';
const ADMIN_KEY = process.env.ADMIN_API_KEY;

if (!ADMIN_KEY) {
  console.error('Missing ADMIN_API_KEY');
  process.exit(1);
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${ADMIN_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path}: ${res.status} ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function main() {
  console.log('=== Setting up E2E test agents ===\n');

  // 1. Create 3 agents
  const agents = {};
  for (const name of ['test-claude-code', 'test-openrouter', 'test-agent-sdk']) {
    const agent = await api('POST', '/agents', { name });
    agents[name] = agent;
    console.log(`Created agent "${name}": id=${agent.id}, apiKey=${agent.apiKey}`);
  }

  // 2. List skills to get their IDs
  const skillsData = await api('GET', '/admin/skills');
  console.log(`\nDiscovered ${skillsData.skills.length} skills:`);
  for (const s of skillsData.skills) {
    console.log(`  - ${s.name} (id=${s.id}, scripts=[${s.scripts.join(', ')}])`);
  }

  const skillIds = skillsData.skills.map(s => s.id);

  // 3. Grant all skills to all agents
  for (const [name, agent] of Object.entries(agents)) {
    await api('PUT', `/agents/${agent.id}/skills`, { skillIds });
    console.log(`Granted ${skillIds.length} skills to "${name}"`);
  }

  // 4. Output JSON for downstream tests
  const output = {};
  for (const [name, agent] of Object.entries(agents)) {
    output[name] = { id: agent.id, apiKey: agent.apiKey };
  }

  console.log('\n=== Agent credentials (for test scripts) ===');
  console.log(JSON.stringify(output, null, 2));

  // Write to temp file for other scripts to read
  const fs = await import('node:fs');
  fs.writeFileSync(
    new URL('./test-agents.json', import.meta.url),
    JSON.stringify(output, null, 2),
  );
  console.log('\nCredentials written to tests/test-agents.json');
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
