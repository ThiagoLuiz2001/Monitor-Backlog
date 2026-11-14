const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const MonitorRules = require("../monitor-rules.js");

function event() { return { addListener() {} }; }

function makeWorkerHarness() {
  const local = {};
  const session = {};
  const icons = [];
  const titles = [];
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") return { [keys]: local[keys] };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, local[key]]));
          return { ...local };
        },
        async set(values) { Object.assign(local, structuredClone(values)); }
      },
      session: {
        async get(key) { return { [key]: session[key] }; },
        async set(values) { Object.assign(session, values); }
      }
    },
    action: {
      async setIcon(value) { icons.push(value.path); },
      async setTitle(value) { titles.push(value.title); }
    },
    alarms: {
      onAlarm: event(),
      async clear() { return true; },
      async get() { return null; },
      async create() {}
    },
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      getURL(file) { return `chrome-extension://test/${file}`; },
      async getContexts() { return []; },
      async sendMessage() { return { ok: true }; }
    },
    tabs: {
      onActivated: event(),
      onUpdated: event(),
      async query() { return []; },
      async get() { throw new Error("No mapped tab in this isolated test."); }
    },
    scripting: { async executeScript() { return []; } },
    notifications: { async clear() { return true; }, async create() {} },
    offscreen: { async createDocument() {} }
  };
  const context = vm.createContext({ chrome, crypto: { randomUUID: () => "test-session" }, console });
  context.importScripts = () => { context.MonitorRules = MonitorRules; };
  const source = fs.readFileSync(path.join(__dirname, "..", "service-worker.js"), "utf8");
  vm.runInContext(source, context, { filename: "service-worker.js" });
  return { context, local, icons, titles };
}

test("the service worker maps the four aggregate states to toolbar icons", async () => {
  const { context, icons, titles } = makeWorkerHarness();
  const panel = (kind, status = "OK") => ({ checkedAt: 1, kind, status });
  const makeState = (running, panels) => ({ running, panels });

  const samples = [
    ["idle", makeState(false, { aptiv: panel("empty"), aptivPoland: panel("empty"), brasilseg: panel("empty") })],
    ["error", makeState(true, { aptiv: panel("unknown", "Falha de leitura"), aptivPoland: panel("empty"), brasilseg: panel("empty") })],
    ["inconclusive", makeState(true, { aptiv: panel("empty"), aptivPoland: panel("unknown", "Consulta de usuários inconclusiva"), brasilseg: panel("empty") })],
    ["success", makeState(true, { aptiv: panel("empty"), aptivPoland: panel("backlog"), brasilseg: panel("empty") })]
  ];
  for (const [status, state] of samples) {
    await context.updateActionIcon(state);
    assert.equal(icons.at(-1)[16], `icons/status/${status}16.png`);
    assert.equal(icons.at(-1)[32], `icons/status/${status}32.png`);
    assert.match(titles.at(-1), /Monitor de Backlog ServiceNow/);
  }
});

test("START and STOP update the saved state without waiting for a full scan", async () => {
  const { context, local, icons } = makeWorkerHarness();
  const started = await context.handleMessage({ type: "START" }, {});
  assert.equal(started.state.running, true);
  const stopped = await context.handleMessage({ type: "STOP" }, {});
  assert.equal(stopped.state.running, false);
  await context.updateActionIcon(stopped.state);
  assert.equal(local.monitorState.running, false);
  assert.equal(icons.at(-1)[16], "icons/status/idle16.png");
});
