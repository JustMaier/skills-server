/**
 * E2E test script for @skills-server/client-openrouter
 * Usage: node test-e2e.mjs
 */

import { createSkillsProvider, toToolResult } from './dist/index.js';

const SERVER_URL = 'http://localhost:3000';
const API_KEY = 'sk-agent-687c4cd2e842b0954f4d464bdc657b5e';
const results = [];

function assert(condition, testName, detail = '') {
  const status = condition ? 'PASS' : 'FAIL';
  const msg = detail ? `[${status}] ${testName} -- ${detail}` : `[${status}] ${testName}`;
  console.log(msg);
  results.push({ testName, passed: condition });
}

async function run() {
  console.log('=== OpenRouter Client E2E Tests ===');
  console.log('');

  // 1. createSkillsProvider
  let provider;
  try {
    provider = await createSkillsProvider(SERVER_URL, API_KEY);
    const names = provider.skillNames;
    assert(
      names.includes('hello'),
      'createSkillsProvider: skillNames includes hello',
      `skillNames = [${names.join(', ')}]`,
    );
    assert(
      names.includes('weather'),
      'createSkillsProvider: skillNames includes weather',
      `skillNames = [${names.join(', ')}]`,
    );
  } catch (err) {
    assert(false, 'createSkillsProvider: creation succeeds', err.message);
    printSummary();
    process.exit(1);
  }

  // 2. load_skill hello
  try {
    const loadResult = await provider.handleToolCall('load_skill', { skill: 'hello' });
    assert(
      loadResult.success === true,
      'load_skill(hello): success is true',
      `success=${loadResult.success}`,
    );
    assert(
      typeof loadResult.stdout === 'string' && loadResult.stdout.length > 0,
      'load_skill(hello): stdout contains skill content',
      `stdout length=${loadResult.stdout.length}`,
    );
  } catch (err) {
    assert(false, 'load_skill(hello): does not throw', err.message);
  }

  // 3. provider.skills map has hello
  assert(
    provider.skills.has('hello'),
    'provider.skills has hello after load_skill',
    `skills keys = [${[...provider.skills.keys()].join(', ')}]`,
  );

  // 4. use_skill hello
  try {
    const useResult = await provider.handleToolCall('use_skill', {
      skill: 'hello',
      script: 'hello.mjs',
      args: ['world'],
    });
    assert(
      useResult.success === true,
      'use_skill(hello, hello.mjs, [world]): success is true',
      `success=${useResult.success}`,
    );
    assert(
      typeof useResult.stdout === 'string' && useResult.stdout.includes('Hello'),
      'use_skill(hello, hello.mjs, [world]): stdout contains Hello',
      `stdout=${JSON.stringify(useResult.stdout)}`,
    );
  } catch (err) {
    assert(false, 'use_skill(hello): does not throw', err.message);
  }

  // 5. toToolResult success
  try {
    const fakeSuccess = {
      success: true,
      stdout: 'some output',
      stderr: '',
      exitCode: 0,
      error: null,
      durationMs: 42,
    };
    const toolRes = toToolResult(fakeSuccess);
    assert(
      toolRes.ok === true,
      'toToolResult(success): ok is true',
      `ok=${toolRes.ok}`,
    );
    assert(
      toolRes.result === 'some output',
      'toToolResult(success): result matches stdout',
      `result=${JSON.stringify(toolRes.result)}`,
    );
  } catch (err) {
    assert(false, 'toToolResult success: does not throw', err.message);
  }

  // toToolResult failure
  try {
    const fakeFail = {
      success: false,
      stdout: '',
      stderr: 'bad stuff',
      exitCode: 1,
      error: 'SomeError',
      durationMs: 10,
    };
    const toolRes = toToolResult(fakeFail);
    assert(
      toolRes.ok === false,
      'toToolResult(failure): ok is false',
      `ok=${toolRes.ok}`,
    );
    assert(
      toolRes.error === 'SomeError',
      'toToolResult(failure): error matches',
      `error=${JSON.stringify(toolRes.error)}`,
    );
    assert(
      toolRes.message === 'bad stuff',
      'toToolResult(failure): message matches stderr',
      `message=${JSON.stringify(toolRes.message)}`,
    );
  } catch (err) {
    assert(false, 'toToolResult failure: does not throw', err.message);
  }

  // 6. Error case: nonexistent skill
  try {
    const errResult = await provider.handleToolCall('load_skill', { skill: 'nonexistent_skill_xyz' });
    assert(
      errResult.success === false,
      'load_skill(nonexistent): success is false',
      `success=${errResult.success}`,
    );
    assert(
      errResult.error === 'SkillNotFound',
      'load_skill(nonexistent): error is SkillNotFound',
      `error=${JSON.stringify(errResult.error)}`,
    );
  } catch (err) {
    assert(false, 'load_skill nonexistent: does not throw', err.message);
  }

  // 7. Include/exclude filtering
  try {
    const filteredProvider = await createSkillsProvider(SERVER_URL, API_KEY, {
      include: ['hello'],
    });
    const names = filteredProvider.skillNames;
    assert(
      names.includes('hello'),
      'filtered provider: skillNames includes hello',
      `skillNames = [${names.join(', ')}]`,
    );
    assert(
      !names.includes('weather'),
      'filtered provider: skillNames does NOT include weather',
      `skillNames = [${names.join(', ')}]`,
    );
    assert(
      names.length === 1,
      'filtered provider: only one skill present',
      `count=${names.length}`,
    );
  } catch (err) {
    assert(false, 'filtered provider: creation succeeds', err.message);
  }

  printSummary();
}

function printSummary() {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log('');
  console.log('=== Summary ===');
  console.log(`Total: ${total}  Passed: ${passed}  Failed: ${failed}`);

  if (failed > 0) {
    console.log('Failed tests:');
    for (const r of results) {
      if (!r.passed) console.log(`  - ${r.testName}`);
    }
    process.exit(1);
  } else {
    console.log('All tests passed.');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
