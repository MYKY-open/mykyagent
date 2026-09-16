/**
 * Offline tests for the MCP adapter core (mcp.ts).
 *
 * Load-bearing properties: tool names can never collide or escape the
 * mcp_ prefix, output caps protect the context window, JSON-RPC framing
 * survives chunked reads, and the registry cleans up after failed connects.
 * Local-only networking: a tiny fake HTTP MCP server + a fake stdio server.
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

const DIR = mkdtempSync(join(tmpdir(), "mykyagent-mcp-"));
process.env.MYKYAGENT_MCP_FILE = join(DIR, "mcp.json");
process.env.MYKYAGENT_MCPKILL_FILE = join(DIR, "mcpkill.json");

const M = await import("./mcp.ts");

let pass = 0,
  fail = 0;
const t = (name: string, cond: boolean, extra = "") => {
  if (cond) {
    pass++;
    console.log(` PASS  ${name}`);
  } else {
    fail++;
    console.log(` FAIL  ${name} ${extra}`);
  }
};
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

t("sanitizeToken lowercases and collapses junk", M.sanitizeToken("Hello World!! 42") === "hello_world_42", M.sanitizeToken("Hello World!! 42"));
t("sanitizeToken strips leading/trailing underscores", M.sanitizeToken("__foo--bar__") === "foo_bar");
t("sanitizeToken caps length", M.sanitizeToken("x".repeat(100)).length === 24);
t("mcpToolName prefixes and sanitizes", M.mcpToolName("Chrome DevTools", "take_screenshot!") === "mcp_chrome_devtools_take_screenshot");
t("mcpToolName caps total length", M.mcpToolName("s".repeat(40), "t".repeat(40)).length <= 64);
t("distinct servers produce distinct prefixes", (() => {
  const a = M.mcpToolName("server-a", "echo");
  const b = M.mcpToolName("server-b", "echo");
  return a.startsWith("mcp_server_a_") && b.startsWith("mcp_server_b_") && a !== b;
})());
t("same server name in different spellings collides by design (sanitizeToken)", M.mcpToolName("a-b", "x") === M.mcpToolName("a_b", "x"));

t("extractSseDataFrames parses data lines", (() => {
  const frames = M.extractSseDataFrames('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\ndata: {"a":2}\n');
  return eq(frames, [{ jsonrpc: "2.0", id: 1, result: { ok: 1 } }, { a: 2 }]);
})());
t("extractSseDataFrames tolerates junk and CRLF", eq(M.extractSseDataFrames('data: not-json\r\ndata: {"id":3}\r\n'), [{ id: 3 }]));

t("capResultText passes short text through", M.capResultText("hello", 8000) === "hello");
t("capResultText truncates and marks", (() => {
  const out = M.capResultText("y".repeat(9001), 8000);
  return out.length < 9001 && out.includes("[... MCP tool output truncated");
})());

t("normalizeMcpResult maps text blocks", (() => {
  const r = M.normalizeMcpResult({ content: [{ type: "text", text: "abc" }] }, 8000);
  return r.content.length === 1 && r.content[0].text === "abc" && !r.isError;
})());
t("normalizeMcpResult maps image blocks", (() => {
  const r = M.normalizeMcpResult({ content: [{ type: "image", data: "AAA=", mimeType: "image/jpeg" }] }, 8000);
  return r.content[0].type === "image" && r.content[0].mimeType === "image/jpeg";
})());
t("normalizeMcpResult caps text and flags isError", (() => {
  const r = M.normalizeMcpResult({ isError: true, content: [{ type: "text", text: "z".repeat(9000) }] }, 8000);
  return r.isError === true && r.content[0].text.length < 9000;
})());
t("normalizeMcpResult stringifies structured fallback", (() => {
  const r = M.normalizeMcpResult({ structuredContent: { answer: 42 }, content: [] }, 8000);
  return r.content[0].text.includes("42");
})());
t("normalizeMcpResult handles garbage", (() => {
  const r = M.normalizeMcpResult(null, 8000);
  return r.content.length === 1 && typeof r.content[0].text === "string";
})());

t("validateInputSchema keeps valid object schemas", M.validateInputSchema({ type: "object", properties: { a: {} } }).properties.a !== undefined);
t("validateInputSchema replaces bad schemas", (() => {
  const s = M.validateInputSchema("nonsense");
  return s.type === "object" && typeof s.properties === "object";
})());

// ---------------------------------------------------------------------------
// 2. Config coercion + persistence + killswitch
// ---------------------------------------------------------------------------

t("coerceConfig: stdio from command", (() => {
  const c = M.coerceConfig({ command: "npx chrome-devtools-mcp@latest", args: ["--x"] });
  return c?.transport === "stdio" && (c as any).args?.[0] === "--x";
})());
t("coerceConfig: http from host/port", (() => {
  const c = M.coerceConfig({ host: "10.0.0.5", port: "9222" });
  return c?.transport === "http" && (c as any).port === 9222;
})());
t("coerceConfig: rejects garbage", M.coerceConfig({ host: "x" }) === null && M.coerceConfig(null) === null && M.coerceConfig({ port: 99999 }) === null);

t("server configs persist round-trip", (() => {
  M.saveServerConfigs({ devtools: { transport: "stdio", command: "npx", args: ["-y", "@chrome-devtools/mcp"] } });
  const loaded = M.loadServerConfigs();
  return loaded.devtools?.transport === "stdio" && existsSync(M.mcpConfigFile());
})());
t("loadServerConfigs survives corrupt json", (() => {
  writeFileSync(M.mcpConfigFile(), "{broken", "utf-8");
  return eq(M.loadServerConfigs(), {});
})());

t("killswitch defaults to enabled", M.mcpDisabled() === false);
t("killswitch flips and persists", (() => {
  M.setMcpDisabled(true);
  const on = M.mcpDisabled();
  M.setMcpDisabled(false);
  return on === true && M.mcpDisabled() === false;
})());

// ---------------------------------------------------------------------------
// 3. HTTP transport against a fake streamable-HTTP MCP server
// ---------------------------------------------------------------------------

function fakeHttpMcp(): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePort) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body || "{}");
        const reply = (result: any) => {
          res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "sess-1" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        };
        if (msg.method === "initialize") {
          reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "0.1" } });
        } else if (msg.method === "tools/list") {
          reply({ tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
        } else if (msg.method === "tools/call") {
          if (req.headers["mcp-session-id"] !== "sess-1") {
            res.writeHead(400).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: "bad session" } }));
            return;
          }
          reply({ content: [{ type: "text", text: `echo:${msg.params.arguments.text}` }] });
        } else if (msg.method === "sse") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { via: "sse" } })}\n\n`);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } }));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolvePort({ server, port: (server.address() as any).port }));
  });
}

{
  const { server, port } = await fakeHttpMcp();
  const tr = new M.HttpMcpTransport({ transport: "http", host: "127.0.0.1", port, path: "mcp" });

  const client = new M.McpClient(tr);
  await client.initialize(5000);
  t("http: initialize captures serverInfo", client.serverInfo?.name === "fake", JSON.stringify(client.serverInfo));

  const tools = await client.listTools(5000);
  t("http: tools/list", tools.length === 1 && tools[0].name === "echo");

  const called = await client.callTool("echo", { text: "hi" }, 5000);
  t("http: tools/call routes session id", called.content[0].text === "echo:hi", JSON.stringify(called));

  const sse = await tr.request("sse", {}, 5000);
  t("http: SSE-framed responses parse", sse.via === "sse", JSON.stringify(sse));

  let errored = "";
  try {
    await tr.request("nope", {}, 5000);
  } catch (e: any) {
    errored = e.message;
  }
  t("http: JSON-RPC errors surface", errored.includes("-32601"), errored);

  let timeoutErred = "";
  try {
    const dead = new M.HttpMcpTransport({ transport: "http", host: "127.0.0.1", port: 1, path: "mcp" });
    await dead.request("initialize", {}, 1000);
  } catch (e: any) {
    timeoutErred = e.message;
  }
  t("http: unreachable server throws cleanly", timeoutErred.length > 0, timeoutErred);

  await tr.close();
  t("http: close sends DELETE without throw", true);
  await new Promise<void>((r) => server.close(() => r()));
}

// ---------------------------------------------------------------------------
// 4. stdio transport against a fake newline-JSON server (chunked writes)
// ---------------------------------------------------------------------------

{
  // The fake server writes its reply in THREE chunks to prove the line
  // reassembler handles partial reads, and prints a banner first.
  const serverScript = join(DIR, "fake_stdio_mcp.mjs");
  writeFileSync(
    serverScript,
    `
process.stdout.write("I am a chatty server banner\\n");
let buf = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.method === "initialize") {
      const out = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "fake-stdio", version: "1" } } }) + "\\n";
      process.stdout.write(out.slice(0, 10));
      setTimeout(() => process.stdout.write(out.slice(10)), 10);
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "double", description: "doubles n", inputSchema: { type: "object", properties: { n: { type: "number" } } } }] } }) + "\\n");
    } else if (msg.method === "tools/call") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(msg.params.arguments.n * 2) }] } }) + "\\n");
    } else if (msg.method === "die") {
      process.exit(7);
    } else if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } }) + "\\n");
    }
  }
});
`,
    "utf-8"
  );

  const tr = new M.StdioMcpTransport({ transport: "stdio", command: process.execPath, args: [serverScript] });
  const client = new M.McpClient(tr);
  await client.initialize(5000);
  t("stdio: initialize across chunked writes", client.serverInfo?.name === "fake-stdio", JSON.stringify(client.serverInfo));

  const tools = await client.listTools(5000);
  t("stdio: tools/list", tools[0]?.name === "double");

  const called = await client.callTool("double", { n: 21 }, 5000);
  t("stdio: tools/call", called.content[0].text === "42");

  let methodErr = "";
  try {
    await tr.request("bogus", {}, 5000);
  } catch (e: any) {
    methodErr = e.message;
  }
  t("stdio: server error replies reject", methodErr.includes("-32601"), methodErr);

  let exitErr = "";
  try {
    await tr.request("die", {}, 5000);
  } catch (e: any) {
    exitErr = e.message;
  }
  t("stdio: server exit rejects pending with code", exitErr.includes("exited"), exitErr);
  await tr.close().catch(() => {});
}

// ---------------------------------------------------------------------------
// 5. Registry behavior (with stub hooks)
// ---------------------------------------------------------------------------

{
  const registered = new Map<string, any>();
  const reg = new M.McpRegistry();
  reg.hooks = {
    register: (def) => registered.set(def.name, def),
    unregister: (name) => registered.delete(name),
  };

  let blocked = "";
  M.setMcpDisabled(true);
  try {
    await reg.connect("x", { transport: "stdio", command: "true" });
  } catch (e: any) {
    blocked = e.message;
  }
  M.setMcpDisabled(false);
  t("registry: connect refused while killswitched", blocked.includes("DISABLED"), blocked);

  const summary1 = reg.connect("bad", { transport: "http", host: "127.0.0.1", port: 1 }).then(
    () => "connected",
    (e) => e.message
  );
  const failMsg = await summary1;
  t("registry: failed connect does not leave state", failMsg.includes("Failed to connect") && !reg.isConnected("bad") && reg.registeredToolNames().length === 0, failMsg);

  // Fake stdio server again, through the full connect() path.
  const serverScript = join(DIR, "fake_stdio_mcp.mjs");
  const report = await reg.connect("devtools", { transport: "stdio", command: process.execPath, args: [serverScript] });
  t("registry: connect registers prefixed tools", registered.has("mcp_devtools_double"), report);
  t("registry: tools callable via callTool", (await reg.callTool("devtools", "double", { n: 5 })).content[0].text === "10");
  t("registry: execute(id, args) signature matches pi — args go to the server", (() => {
    const def = registered.get("mcp_devtools_double");
    if (!def || def.execute.length !== 2) return false;
    // The trap this guards against: pi calls execute(toolCallId, params). A
    // closure that treats the first arg as params sends the id string as
    // `arguments` and the server rejects it (zod invalid_type on record).
    return def.execute("call-id-123", { n: 3 }).then((r: any) => r?.content?.[0]?.text === "6");
  })());
  t("registry: summary lists server", reg.summary().includes("devtools") && reg.summary().includes("mcp_devtools_double"));
  t("registry: config persisted on connect", M.loadServerConfigs().devtools?.transport === "stdio");

  const disc = await reg.disconnect("devtools");
  t("registry: disconnect unregisters tools", registered.size === 0 && !reg.isConnected("devtools"), disc);
  t("registry: disconnect removes persisted config", M.loadServerConfigs().devtools === undefined);
  t("registry: reconnectPersisted on empty config is a no-op", (await reg.reconnectPersisted()).connected.length === 0);
  t("registry: disconnectAll (killswitch teardown) KEEPS config", (() => {
    return reg
      .connect("devtools", { transport: "stdio", command: process.execPath, args: [serverScript] })
      .then(() => reg.disconnectAll())
      .then(() => !reg.isConnected("devtools") && M.loadServerConfigs().devtools?.transport === "stdio");
  })());

  let unknown = "";
  try {
    await reg.callTool("ghost", "tool", {});
  } catch (e: any) {
    unknown = e.message;
  }
  t("registry: callTool on unknown server errors clearly", unknown.includes("not connected"), unknown);
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
