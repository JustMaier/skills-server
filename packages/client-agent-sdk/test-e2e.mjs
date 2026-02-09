/**
 * E2E test script for @skills-server/client-agent-sdk
 *
 * Tests both the SDK exports (with a mock of @anthropic-ai/claude-agent-sdk)
 * and the underlying HTTP API endpoints that the SDK proxies.
 */

const BASE_URL = "http://localhost:3000";
const API_KEY = "sk-agent-e4a6d4337d0cd0a5b1d89570564ecc17";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const results = [];

function pass(name) {
  results.push({ name, ok: true });
  console.log("  PASS  " + name);
}

function fail(name, reason) {
  results.push({ name, ok: false, reason });
  console.log("  FAIL  " + name);
  console.log("        " + reason);
}

function assert(cond, name, reason) {
  if (cond) pass(name);
  else fail(name, reason);
}

// ---------------------------------------------------------------------------
// SDK tests - require the mock loader
// ---------------------------------------------------------------------------

async function testSdkExports() {
  console.log("");
  console.log("-- SDK export tests -----------------------------------------------");
  console.log("");

  let createSkillsServerConfig, createSkillsServer;
  try {
    const mod = await import("./dist/index.js");
    createSkillsServerConfig = mod.createSkillsServerConfig;
    createSkillsServer = mod.createSkillsServer;
  } catch (err) {
    console.log("  SKIP  SDK exports not importable (claude-agent-sdk peer dep not available)");
    console.log("        " + err.message);
    console.log("");
    return false;
  }

  const config = createSkillsServerConfig(BASE_URL, API_KEY);

  assert(
    config && typeof config === "object",
    "createSkillsServerConfig returns an object",
    "Expected object, got " + typeof config,
  );

  assert(
    config.mcpServers && typeof config.mcpServers === "object",
    "config has mcpServers key (object)",
    "mcpServers is " + typeof config.mcpServers,
  );

  assert(
    Array.isArray(config.allowedTools),
    "config has allowedTools key (array)",
    "allowedTools is " + typeof config.allowedTools,
  );

  const expectedTools = [
    "mcp__skills-server__list_skills",
    "mcp__skills-server__load_skill",
    "mcp__skills-server__execute_skill",
  ];
  assert(
    config.allowedTools.length === 3 &&
      expectedTools.every((t) => config.allowedTools.includes(t)),
    "allowedTools contains the 3 expected tool names",
    "Got: " + JSON.stringify(config.allowedTools),
  );

  const server = createSkillsServer(BASE_URL, API_KEY);

  assert(
    server && server.name === "skills-server",
    "createSkillsServer returns server with name skills-server",
    "server.name = " + (server ? server.name : "undefined"),
  );

  return true;
}

// ---------------------------------------------------------------------------
// HTTP API tests (no SDK import required)
// ---------------------------------------------------------------------------

async function testHttpApi() {
  console.log("");
  console.log("-- HTTP API tests (underlying endpoints) --------------------------");
  console.log("");

  // -- 1. list_skills --
  {
    const res = await fetch(BASE_URL + "/api/v1/skills", {
      headers: { Authorization: "Bearer " + API_KEY },
    });

    assert(res.ok, "GET /api/v1/skills returns 200", "Status: " + res.status);

    const body = await res.json();
    assert(Array.isArray(body), "list_skills response is an array", "Got: " + typeof body);

    const names = body.map((s) => s.name);
    assert(
      names.includes("hello") && names.includes("weather"),
      "list_skills contains hello and weather skills",
      "Got names: " + JSON.stringify(names),
    );

    const hello = body.find((s) => s.name === "hello");
    assert(
      hello && Array.isArray(hello.scripts) && hello.scripts.length > 0,
      "hello skill has scripts array with entries",
      "scripts: " + JSON.stringify(hello ? hello.scripts : null),
    );
  }

  // -- 2. load_skill (hello) --
  {
    const res = await fetch(BASE_URL + "/api/v1/skills/hello", {
      headers: { Authorization: "Bearer " + API_KEY },
    });

    assert(res.ok, "GET /api/v1/skills/hello returns 200", "Status: " + res.status);

    const body = await res.json();
    assert(
      body.name === "hello",
      "load_skill response has name: hello",
      "name: " + body.name,
    );
    assert(
      typeof body.content === "string" && body.content.length > 0,
      "load_skill response has non-empty content string",
      "content type: " + typeof body.content + ", length: " + (body.content ? body.content.length : 0),
    );
    assert(
      Array.isArray(body.scripts),
      "load_skill response has scripts array",
      "scripts: " + typeof body.scripts,
    );
    assert(
      body.frontmatter && typeof body.frontmatter === "object",
      "load_skill response has frontmatter object",
      "frontmatter: " + typeof body.frontmatter,
    );
  }

  // -- 3. execute_skill (hello) --
  {
    const res = await fetch(BASE_URL + "/api/v1/skills/hello/execute", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ script: "hello.mjs", args: ["world"] }),
    });

    assert(res.ok, "POST /api/v1/skills/hello/execute returns 200", "Status: " + res.status);

    const body = await res.json();
    assert(body.success === true, "execute_skill returns success: true", "success: " + body.success);
    assert(
      typeof body.stdout === "string" && body.stdout.includes("Hello"),
      "execute_skill stdout contains Hello",
      "stdout: " + JSON.stringify(body.stdout),
    );
    assert(
      typeof body.exitCode === "number" && body.exitCode === 0,
      "execute_skill exitCode is 0",
      "exitCode: " + body.exitCode,
    );
    assert(
      typeof body.durationMs === "number" && body.durationMs >= 0,
      "execute_skill has durationMs >= 0",
      "durationMs: " + body.durationMs,
    );
  }

  // -- 4. Permission denied (invalid API key) --
  {
    const res = await fetch(BASE_URL + "/api/v1/skills", {
      headers: { Authorization: "Bearer sk-invalid-key-00000000000000000000" },
    });

    assert(
      res.status === 401,
      "GET /api/v1/skills with invalid key returns 401",
      "Status: " + res.status,
    );
  }

  // -- 5. 404 for nonexistent skill --
  {
    const res = await fetch(BASE_URL + "/api/v1/skills/nonexistent", {
      headers: { Authorization: "Bearer " + API_KEY },
    });

    assert(
      res.status === 404,
      "GET /api/v1/skills/nonexistent returns 404",
      "Status: " + res.status,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("==========================================================");
  console.log(" @skills-server/client-agent-sdk -- E2E Tests");
  console.log("==========================================================");
  console.log("Server:  " + BASE_URL);

  // Check server is up
  try {
    const ping = await fetch(BASE_URL + "/api/v1/skills", {
      headers: { Authorization: "Bearer " + API_KEY },
    });
    if (!ping.ok) throw new Error("Status " + ping.status);
  } catch (err) {
    console.error("");
    console.error("ERROR: Cannot reach server at " + BASE_URL);
    console.error("       " + err.message);
    process.exit(1);
  }

  // Run SDK tests (may be skipped if peer dep not available)
  await testSdkExports();

  // Run HTTP API tests
  await testHttpApi();

  // Summary
  console.log("");
  console.log("==========================================================");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(" Summary: " + passed + " passed, " + failed + " failed, " + results.length + " total");
  console.log("==========================================================");
  console.log("");

  if (failed > 0) {
    console.log("Failed tests:");
    for (const r of results.filter((r) => !r.ok)) {
      console.log("  - " + r.name + ": " + r.reason);
    }
    console.log("");
    process.exit(1);
  }
}

main();
