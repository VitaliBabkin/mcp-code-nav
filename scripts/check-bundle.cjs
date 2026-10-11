// Node-only stdio handshake: starts the given server file, lists its tools, exits non-zero on any failure.
// Usage: node scripts/check-bundle.cjs <path-to-server.js>
const { spawn } = require("node:child_process");

const TIMEOUT_MS = 30000;

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/check-bundle.cjs <path-to-server.js>");
  process.exit(2);
}

const server = spawn(process.execPath, [target], { stdio: ["pipe", "pipe", "inherit"] });
const send = (message) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const fail = (reason) => {
  console.error(`check-bundle: ${reason}`);
  server.kill();
  process.exitCode = 1;
};
const timer = setTimeout(() => fail(`no complete handshake within ${TIMEOUT_MS} ms`), TIMEOUT_MS);

server.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (process.exitCode === undefined && !done) {
    fail(`server exited early (code ${code}, signal ${signal})`);
  }
});

let done = false;
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    const reply = JSON.parse(line);
    if (reply.id === 1) {
      console.log("server:", reply.result.serverInfo.name, reply.result.serverInfo.version);
      send({ method: "notifications/initialized" });
      send({ id: 2, method: "tools/list" });
    } else if (reply.id === 2) {
      const names = reply.result.tools.map((t) => t.name);
      console.log(names.length, "tools:", names.join(", "));
      done = true;
      if (names.length === 0) {
        fail("the server lists no tools");
      }
      clearTimeout(timer);
      server.kill();
    }
  }
});

send({
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "check", version: "0" } },
});
