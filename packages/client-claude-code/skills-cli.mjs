#!/usr/bin/env node

// Skills Server CLI — standalone client for the skills server HTTP API.
// Requires SKILLS_SERVER_URL and SKILLS_SERVER_API_KEY environment variables.
// Usage: node skills-cli.mjs <command> [args...]

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SKILLS_SERVER_URL = process.env.SKILLS_SERVER_URL;
const SKILLS_SERVER_API_KEY = process.env.SKILLS_SERVER_API_KEY;

function requireEnv() {
  const missing = [];
  if (!SKILLS_SERVER_URL) missing.push('SKILLS_SERVER_URL');
  if (!SKILLS_SERVER_API_KEY) missing.push('SKILLS_SERVER_API_KEY');
  if (missing.length > 0) {
    console.error(`Error: Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('Set these variables before running the CLI.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Base URL with trailing slash stripped. */
function baseUrl() {
  return SKILLS_SERVER_URL.replace(/\/+$/, '');
}

/** Standard headers for all requests. */
function headers(extra = {}) {
  return {
    'Authorization': `Bearer ${SKILLS_SERVER_API_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

/**
 * Make an HTTP request to the skills server.
 * Returns the parsed JSON body. Exits with an error on failure.
 */
async function request(method, path, body) {
  const url = `${baseUrl()}${path}`;
  const options = {
    method,
    headers: headers(),
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    console.error(`Error: Failed to connect to ${url}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  let data;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else {
    const text = await res.text();
    data = { message: text };
  }

  if (!res.ok) {
    console.error(`Error: HTTP ${res.status} ${res.statusText}`);
    if (data && data.error) {
      console.error(`  ${data.error}`);
    } else if (data && data.message) {
      console.error(`  ${data.message}`);
    }
    process.exit(1);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function listSkills() {
  const skills = await request('GET', '/api/v1/skills');
  console.log(JSON.stringify(skills, null, 2));
}

async function loadSkill(name) {
  if (!name) {
    console.error('Error: Skill name is required.');
    console.error('Usage: skills-cli.mjs load <name>');
    process.exit(1);
  }
  const skill = await request('GET', `/api/v1/skills/${encodeURIComponent(name)}`);
  console.log(JSON.stringify(skill, null, 2));
}

async function execSkill(name, script, args) {
  if (!name || !script) {
    console.error('Error: Skill name and script are required.');
    console.error('Usage: skills-cli.mjs exec <name> <script> [args...]');
    process.exit(1);
  }
  const result = await request('POST', `/api/v1/skills/${encodeURIComponent(name)}/execute`, {
    script,
    args: args || [],
  });
  console.log(JSON.stringify(result, null, 2));
}

function printHelp() {
  const help = `
skills-cli.mjs — CLI client for the skills server

Usage:
  skills-cli.mjs list                          List available skills
  skills-cli.mjs load <name>                   Load a skill's full content
  skills-cli.mjs exec <name> <script> [args]   Execute a script within a skill
  skills-cli.mjs help                          Show this help message

Environment:
  SKILLS_SERVER_URL       Base URL of the skills server (required)
  SKILLS_SERVER_API_KEY   Agent API key for authentication (required)

Examples:
  skills-cli.mjs list
  skills-cli.mjs load weather
  skills-cli.mjs exec weather weather.mjs "New York"
`.trim();
  console.log(help);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  requireEnv();

  switch (command) {
    case 'list':
      await listSkills();
      break;
    case 'load':
      await loadSkill(args[0]);
      break;
    case 'exec':
      await execSkill(args[0], args[1], args.slice(2));
      break;
    default:
      console.error(`Error: Unknown command "${command}"`);
      console.error('Run "skills-cli.mjs help" for usage.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
