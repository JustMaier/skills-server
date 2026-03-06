#!/usr/bin/env node

// skills-cli.mjs — Standalone CLI for the Skills Server (zero dependencies)
// Config: SKILLS_SERVER_URL, SKILLS_SERVER_KEY

const VERSION = '1.0.0';

const BASE_URL = process.env.SKILLS_SERVER_URL?.replace(/\/+$/, '');
const API_KEY = process.env.SKILLS_SERVER_KEY;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function requireConfig() {
  if (!BASE_URL) die('SKILLS_SERVER_URL is not set');
  if (!API_KEY) die('SKILLS_SERVER_KEY is not set');
}

async function api(method, path, body) {
  requireConfig();
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, opts);
  } catch (err) {
    die(`Request failed: ${err.message}`);
  }

  if (res.status === 204) return null;

  let data;
  try {
    data = await res.json();
  } catch {
    die(`HTTP ${res.status} — non-JSON response`);
  }

  if (!res.ok) {
    const msg = data?.error ?? JSON.stringify(data);
    die(`HTTP ${res.status} — ${msg}`);
  }
  return data;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      flags.json = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function out(data, flags, formatter) {
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    formatter(data);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdList(flags) {
  const data = await api('GET', '/api/v1/skills');
  out(data, flags, (skills) => {
    if (skills.length === 0) return console.log('No skills available.');
    const nameW = Math.max(4, ...skills.map((s) => s.name.length));
    console.log(`${'NAME'.padEnd(nameW)}  SCRIPTS  DESCRIPTION`);
    for (const s of skills) {
      const scripts = s.scripts?.length ?? 0;
      const desc = s.description ?? '';
      console.log(`${s.name.padEnd(nameW)}  ${String(scripts).padStart(7)}  ${desc}`);
    }
  });
}

async function cmdLoad(flags, name) {
  if (!name) die('Usage: skills-cli.mjs load <name>');
  const data = await api('GET', `/api/v1/skills/${encodeURIComponent(name)}`);
  out(data, flags, (skill) => {
    console.log(`# ${skill.name}\n`);
    if (skill.description) console.log(`${skill.description}\n`);
    if (skill.scripts?.length) console.log(`Scripts: ${skill.scripts.join(', ')}\n`);
    if (Object.keys(skill.frontmatter ?? {}).length) {
      console.log('Frontmatter:');
      for (const [k, v] of Object.entries(skill.frontmatter)) console.log(`  ${k}: ${v}`);
      console.log();
    }
    console.log(skill.content);
  });
}

async function cmdExec(flags, name, script, args) {
  if (!name || !script) die('Usage: skills-cli.mjs exec <name> <script> [args...]');
  const data = await api('POST', `/api/v1/skills/${encodeURIComponent(name)}/execute`, {
    script,
    args: args ?? [],
  });
  out(data, flags, (r) => {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (!r.success) {
      console.error(`\nExit code: ${r.exitCode} (${r.durationMs}ms)`);
      if (r.error) console.error(`Error: ${r.error}`);
    }
  });
  if (data && !data.success) process.exitCode = 1;
}

async function cmdEnvList(flags) {
  const data = await api('GET', '/api/v1/self/env-vars');
  out(data, flags, (vars) => {
    if (vars.length === 0) return console.log('No environment variables.');
    const idW = Math.max(2, ...vars.map((v) => v.id.length));
    const keyW = Math.max(3, ...vars.map((v) => v.key.length));
    console.log(`${'ID'.padEnd(idW)}  ${'KEY'.padEnd(keyW)}  DESCRIPTION`);
    for (const v of vars) {
      console.log(`${v.id.padEnd(idW)}  ${v.key.padEnd(keyW)}  ${v.description ?? ''}`);
    }
  });
}

async function cmdEnvSet(flags, key, value) {
  if (!key || value === undefined) die('Usage: skills-cli.mjs env set <key> <value> [--desc "..."]');
  const body = { key, value };
  if (flags.desc) body.description = flags.desc;
  const data = await api('POST', '/api/v1/self/env-vars', body);
  out(data, flags, (v) => {
    console.log(`Created env var: ${v.key} (id: ${v.id})`);
  });
}

async function cmdEnvLink(flags, skillId, envVarId) {
  if (!skillId || !envVarId) die('Usage: skills-cli.mjs env link <skillId> <envVarId>');
  await api('POST', `/api/v1/self/skills/${encodeURIComponent(skillId)}/env-vars/${encodeURIComponent(envVarId)}`);
  out(null, flags, () => console.log('Linked.'));
}

async function cmdEnvUnlink(flags, skillId, envVarId) {
  if (!skillId || !envVarId) die('Usage: skills-cli.mjs env unlink <skillId> <envVarId>');
  await api('DELETE', `/api/v1/self/skills/${encodeURIComponent(skillId)}/env-vars/${encodeURIComponent(envVarId)}`);
  out(null, flags, () => console.log('Unlinked.'));
}

async function cmdRegister(flags, repoUrl) {
  if (!repoUrl) die('Usage: skills-cli.mjs register <repoUrl> [--branch main] [--subpath /] [--name skillName] [--authToken TOKEN]');
  const body = { repoUrl };
  if (flags.branch) body.branch = flags.branch;
  if (flags.subpath) body.subpath = flags.subpath;
  if (flags.name) body.name = flags.name;
  if (flags.authToken) body.authToken = flags.authToken;
  const data = await api('POST', '/api/v1/registry', body);
  out(data, flags, (e) => {
    console.log(`Registered: ${e.skillName}`);
    console.log(`  Registry ID: ${e.id}`);
    console.log(`  Skill ID:    ${e.skillId}`);
    console.log(`  Repo:        ${e.repoUrl}`);
    console.log(`  Branch:      ${e.branch}`);
    console.log(`  Status:      ${e.status}`);
  });
}

async function cmdSync(flags, registryId) {
  if (!registryId) die('Usage: skills-cli.mjs sync <registryId>');
  const data = await api('POST', `/api/v1/registry/${encodeURIComponent(registryId)}/sync`);
  out(data, flags, (e) => {
    console.log(`Synced: ${e.skillName}`);
    console.log(`  Status:      ${e.status}`);
    console.log(`  Last synced: ${e.lastSynced ? new Date(e.lastSynced).toISOString() : 'never'}`);
  });
}

async function cmdSyncLocal(flags) {
  const dir = flags.dir || '.claude/skills';
  const skills = await api('GET', '/api/v1/skills');

  const { mkdir, writeFile, cp } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  // Create bootstrap stub: skills-server/SKILL.md + skills-server/skills-cli.mjs
  const bootstrapDir = join(dir, 'skills-server');
  await mkdir(bootstrapDir, { recursive: true });

  const bootstrapMd = `---
name: skills-server
description: Bootstrap skill for the Skills Server. Provides the CLI and teaches agents how to interact with the server.
---

# Skills Server

You are connected to a skills server at \`${BASE_URL}\`.
Your API key is already configured via SKILLS_SERVER_KEY.

## Quick Start

Use the CLI in this directory to interact with the server:

\`\`\`bash
export SKILLS_SERVER_URL="${BASE_URL}"
export SKILLS_SERVER_KEY="$SKILLS_SERVER_KEY"
node skills-cli.mjs list              # See available skills
node skills-cli.mjs load <name>       # Read a skill's instructions
node skills-cli.mjs exec <name> <script> [args...]  # Run a script
\`\`\`

## Self-Service Environment Variables

Skills may require environment variables. If execution returns a 422 error with missing env vars:

\`\`\`bash
node skills-cli.mjs env set <KEY> <VALUE> --desc "description"
node skills-cli.mjs env link <skillId> <envVarId>
\`\`\`

## Skill Registry

Register skills from Git repos (requires maintain permission):

\`\`\`bash
node skills-cli.mjs register <repoUrl> [--branch main] [--subpath /] [--name skillName] [--authToken TOKEN]
node skills-cli.mjs sync <registryId>
\`\`\`

## All Commands

Run \`node skills-cli.mjs\` with no arguments to see full usage.
`;

  await writeFile(join(bootstrapDir, 'SKILL.md'), bootstrapMd);

  // Copy skills-cli.mjs into the bootstrap dir
  const cliSrc = fileURLToPath(import.meta.url);
  await cp(cliSrc, join(bootstrapDir, 'skills-cli.mjs'));

  let count = 1; // bootstrap counts

  // Generate thin stubs for each remote skill (skip skills-server itself)
  for (const skill of skills) {
    if (skill.name === 'skills-server') continue;

    const skillDir = join(dir, skill.name);
    await mkdir(skillDir, { recursive: true });

    const stubMd = `---
name: ${skill.name}
description: ${(skill.description ?? '').replace(/\n/g, ' ')}
---

# ${skill.name}

${skill.description ?? ''}

This skill is hosted on the Skills Server. To use it:

\`\`\`bash
# Read full instructions
node ${join(dir, 'skills-server', 'skills-cli.mjs')} load ${skill.name}

# Execute a script
node ${join(dir, 'skills-server', 'skills-cli.mjs')} exec ${skill.name} <script> [args...]
\`\`\`

${skill.scripts?.length ? `Available scripts: ${skill.scripts.join(', ')}` : ''}
`;

    await writeFile(join(skillDir, 'SKILL.md'), stubMd);
    count++;
  }

  console.log(`Synced ${count} skill stubs to ${dir}/`);
  console.log(`  Bootstrap: ${bootstrapDir}/`);
  for (const skill of skills) {
    if (skill.name === 'skills-server') continue;
    console.log(`  Stub:      ${join(dir, skill.name)}/`);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const USAGE = `Usage: skills-cli.mjs <command> [options]

Commands:
  list                              List available skills
  load <name>                       Get full skill content
  exec <name> <script> [args...]    Execute a skill script
  env list                          List my environment variables
  env set <key> <value> [--desc ""] Create an environment variable
  env link <skillId> <envVarId>     Link env var to a skill
  env unlink <skillId> <envVarId>   Unlink env var from a skill
  register <repoUrl> [options]      Register a skill from a Git repo
  sync <registryId>                 Pull latest and re-discover skill
  sync-local [--dir .claude/skills] Generate thin SKILL.md stubs locally
  version                           Print version

Flags:
  --json        Output raw JSON instead of formatted text
  --authToken   Personal access token for private repos (register only)

Environment:
  SKILLS_SERVER_URL   Server base URL (e.g. http://localhost:3000)
  SKILLS_SERVER_KEY   Agent API key (Bearer token)`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  switch (cmd) {
    case 'list':
      return cmdList(flags);
    case 'load':
      return cmdLoad(flags, positional[1]);
    case 'exec':
      return cmdExec(flags, positional[1], positional[2], positional.slice(3));
    case 'env': {
      const sub = positional[1];
      if (sub === 'list') return cmdEnvList(flags);
      if (sub === 'set') return cmdEnvSet(flags, positional[2], positional[3]);
      if (sub === 'link') return cmdEnvLink(flags, positional[2], positional[3]);
      if (sub === 'unlink') return cmdEnvUnlink(flags, positional[2], positional[3]);
      die(`Unknown env subcommand: ${sub ?? '(none)'}\n\n${USAGE}`);
      break;
    }
    case 'register':
      return cmdRegister(flags, positional[1]);
    case 'sync':
      return cmdSync(flags, positional[1]);
    case 'sync-local':
      return cmdSyncLocal(flags);
    case 'version':
      console.log(`skills-cli ${VERSION}`);
      return;
    default:
      console.log(USAGE);
      if (cmd) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
