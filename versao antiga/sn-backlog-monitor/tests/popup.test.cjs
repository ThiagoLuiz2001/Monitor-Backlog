const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const MonitorRules = require("../monitor-rules.js");

function makeElement() {
  return {
    textContent: "",
    value: "",
    className: "",
    dataset: {},
    disabled: false,
    options: [],
    attributes: {},
    classList: { toggle() {} },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {},
    focus() {}
  };
}

function makePopupHarness() {
  const ids = [
    "toggle-monitor", "theme-toggle", "run-status", "interval", "health-indicator", "health-status", "feedback",
    "test-sound", "save-interval", "refresh-tabs",
    "aptiv-tab", "aptiv-state", "aptiv-detail", "aptiv-time", "aptiv-freshness",
    "aptivPoland-tab", "aptivPoland-state", "aptivPoland-detail", "aptivPoland-time", "aptivPoland-freshness",
    "brasilseg-tab", "brasilseg-state", "brasilseg-detail", "brasilseg-time", "brasilseg-freshness"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, makeElement()]));
  const state = {
    running: false,
    intervalMinutes: 1,
    mapping: { aptiv: null, aptivPoland: null, brasilseg: null },
    targets: { aptiv: null, aptivPoland: null, brasilseg: null },
    panels: Object.fromEntries(["aptiv", "aptivPoland", "brasilseg"].map((key) => [key, {
      status: "Aguardando configuração", detail: "Selecione uma aba", checkedAt: null, kind: "unknown", freshness: ""
    }]))
  };
  const messages = [];
  const stored = { monitorUiTheme: "light" };
  const document = {
    documentElement: { dataset: {} },
    activeElement: null,
    addEventListener() {},
    getElementById(id) { return elements[id]; }
  };
  const chrome = {
    storage: { local: {
      async get(key) { return { [key]: stored[key] }; },
      async set(values) { Object.assign(stored, values); }
    } },
    runtime: { async sendMessage(message) {
      messages.push(message.type);
      if (message.type === "GET_STATE") return { ok: true, state: structuredClone(state) };
      if (message.type === "START") state.running = true;
      if (message.type === "STOP") state.running = false;
      return { ok: true };
    } }
  };
  const context = vm.createContext({ document, chrome, MonitorRules });
  const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
  vm.runInContext(source, context, { filename: "popup.js" });
  return { context, elements, state, messages, stored, document };
}

test("the single popup button follows the confirmed start and stop state", async () => {
  const { context, elements, state, messages } = makePopupHarness();
  await context.renderState();
  assert.equal(elements["toggle-monitor"].textContent, "Iniciar verificação");
  assert.equal(elements["toggle-monitor"].className, "state-button state-button-start");

  await context.toggleMonitoring();
  assert.equal(state.running, true);
  assert.equal(elements["toggle-monitor"].textContent, "Desativar verificação");
  assert.equal(elements["toggle-monitor"].className, "state-button state-button-stop");

  await context.toggleMonitoring();
  assert.equal(state.running, false);
  assert.equal(elements["toggle-monitor"].textContent, "Iniciar verificação");
  assert.ok(messages.includes("START"));
  assert.ok(messages.includes("STOP"));
});

test("the theme control saves and restores the selected appearance", async () => {
  const { context, elements, stored, document } = makePopupHarness();
  await context.initializeTheme();
  assert.equal(document.documentElement.dataset.theme, "light");
  await context.toggleTheme();
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(stored.monitorUiTheme, "dark");
  document.documentElement.dataset.theme = "light";
  await context.initializeTheme();
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(elements["theme-toggle"].textContent, "☀ Modo claro");
});
