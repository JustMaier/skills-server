#!/usr/bin/env node

/**
 * E2E test script for skills-cli.mjs
 *
 * Requires the skills server to be running at SKILLS_SERVER_URL.
 * Spawns the CLI as a child process for each test case and validates
 * stdout / exit codes.
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'skills-cli.mjs');
const NODE = process.execPath; // path to current Node binary

const ENV = {
  ...process.env,
  SKILLS_SERVER_URL: 'http://localhost:3000',
  SKILLS_SERVER_API_KEY: 'sk-agent-47b6c8a30217699c62652166d73c4b0d',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run the CLI with the given args and return { stdout, stderr, code }. */
function run(...args) {
  return new Promise((resolve) => {
    execFile(NODE, [CLI, ...args], { env: ENV, cwd: __dirname, timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: err ? err.code ?? 1 : 0,
      });
    });
  });
}

let passed = 0;
let failed = 0;

function pass(label) {
  passed++;
  console.log(`  PASS  ${label}`);
}

function fail(label, reason) {
  failed++;
  console.log(`  FAIL  ${label}`);
  console.log(`        Reason: ${reason}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testList() {
  const label = 'list — returns array containing hello and weather';
  const { stdout, code } = await run('list');

  if (code !== 0) return fail(label, `exit code ${code}, expected 0`);

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return fail(label, `stdout is not valid JSON: ${stdout.slice(0, 200)}`);
  }

  if (!Array.isArray(data)) return fail(label, `expected array, got ${typeof data}`);

  // The array may contain objects with a "name" field, or bare strings — handle both.
  const names = data.map((item) => (typeof item === 'string' ? item : item?.name));

  if (!names.includes('hello')) return fail(label, `"hello" not found in ${JSON.stringify(names)}`);
  if (!names.includes('weather')) return fail(label, `"weather" not found in ${JSON.stringify(names)}`);

  pass(label);
}

async function testLoad() {
  const label = 'load hello — returns object with name, content, scripts';
  const { stdout, code } = await run('load', 'hello');

  if (code !== 0) return fail(label, `exit code ${code}, expected 0`);

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return fail(label, `stdout is not valid JSON: ${stdout.slice(0, 200)}`);
  }

  if (typeof data !== 'object' || data === null) return fail(label, `expected object, got ${typeof data}`);
  if (!data.name) return fail(label, `missing "name" field`);
  if (!data.content && data.content !== '') return fail(label, `missing "content" field`);
  if (!data.scripts) return fail(label, `missing "scripts" field`);

  pass(label);
}

async function testExec() {
  const label = 'exec hello hello.mjs world — success:true, stdout contains "Hello"';
  const { stdout, code } = await run('exec', 'hello', 'hello.mjs', 'world');

  if (code !== 0) return fail(label, `exit code ${code}, expected 0`);

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    return fail(label, `stdout is not valid JSON: ${stdout.slice(0, 200)}`);
  }

  if (typeof data !== 'object' || data === null) return fail(label, `expected object, got ${typeof data}`);
  if (data.success !== true) return fail(label, `expected success:true, got ${JSON.stringify(data.success)}`);
  if (typeof data.stdout !== 'string' || !data.stdout.includes('Hello')) {
    return fail(label, `expected stdout to contain "Hello", got: ${JSON.stringify(data.stdout)}`);
  }

  pass(label);
}

async function testLoadNonexistent() {
  const label = 'load nonexistent — exits with code 1';
  const { code } = await run('load', 'this-skill-does-not-exist');

  if (code !== 1) return fail(label, `expected exit code 1, got ${code}`);

  pass(label);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log('skills-cli.mjs E2E tests');
  console.log('========================');
  console.log(`Server : ${ENV.SKILLS_SERVER_URL}`);
  console.log(`CLI    : ${CLI}`);
  console.log('');

  await testList();
  await testLoad();
  await testExec();
  await testLoadNonexistent();

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

  if (failed > 0) {
    process.exit(1);
  }
  console.log('All tests passed.');
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
