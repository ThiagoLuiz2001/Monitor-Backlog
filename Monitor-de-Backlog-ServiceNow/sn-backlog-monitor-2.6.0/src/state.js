/**
 * state.js — Estado persistente do monitor, ícones da toolbar e agendamento de alarmes.
 *
 * Carrega via importScripts no service worker; expõe funções e variáveis no
 * escopo global compartilhado dos classic scripts.
 */

const STORE_KEY = "monitorState";
const ACTIVITY_KEY = "panelInteractionTimes";
const ALARM_NAME = "service-now-backlog-check";
const RECHECK_ALARM_PREFIX = "service-now-foreground-recheck-";
const SESSION_TOKEN_KEY = "monitorBrowserSessionToken";
const CYCLE_VERSION_KEY = "monitorCycleVersion";
const MIN_INTERVAL_MINUTES = 0.5;
const RECENT_USE_MS = 2 * 60 * 1000;

const PANEL_INFO = {
  aptiv: { label: "APTIV", host: "aptiv.service-now.com" },
  aptivPoland: { label: "APTIV Polônia", host: "aptiv.service-now.com" },
  brasilseg: { label: "BRASILSEG", host: "brasilseg.service-now.com" }
};

const ACTION_ICONS = {
  idle: { 16: "icons/status/idle16.png", 32: "icons/status/idle32.png" },
  error: { 16: "icons/status/error16.png", 32: "icons/status/error32.png" },
  inconclusive: { 16: "icons/status/inconclusive16.png", 32: "icons/status/inconclusive32.png" },
  success: { 16: "icons/status/success16.png", 32: "icons/status/success32.png" }
};
const ACTION_TITLES = {
  idle: "Em espera",
  error: "Erro em pelo menos um backlog",
  inconclusive: "Há verificações inconclusivas",
  success: "Três backlogs verificados com sucesso"
};

/** Estado de ciclo em memória; persistido em storage.session para sobreviver ao fim do worker. */
let cycleVersion = 0;
let currentCycle = null;
let currentCycleVersion = 0;
let sessionTokenPromise = null;
let restoringMappings = null;
let lastRestoreScanAt = 0;
let creatingOffscreenDocument = null;

/**
 * Cria o objeto de estado de um painel com valores padrão.
 * @returns {object} Estado inicial do painel.
 */
function makePanelState() {
  return {
    status: "Aguardando configuração",
    detail: "Selecione a aba correta deste painel no popup.",
    checkedAt: null,
    kind: "unknown",
    alertActive: false,
    fingerprint: null,
    freshness: "",
    lastSelectedAt: null,
    lastRefreshAt: null
  };
}

/**
 * Estado padrão completo do monitor.
 * @returns {object} Estado inicial mesclado com valores padrão.
 */
function defaultState() {
  return {
    running: false,
    intervalMinutes: 1,
    lastCycleAt: null,
    mapping: { aptiv: null, aptivPoland: null, brasilseg: null },
    targets: { aptiv: null, aptivPoland: null, brasilseg: null },
    mappingSession: { aptiv: null, aptivPoland: null, brasilseg: null },
    panels: { aptiv: makePanelState(), aptivPoland: makePanelState(), brasilseg: makePanelState() }
  };
}

/**
 * Lê o estado salvo mesclando com os padrões (campos novos ausentes em instalações antigas).
 * @returns {Promise<object>} Estado completo e normalizado.
 */
async function readState() {
  const stored = await chrome.storage.local.get(STORE_KEY);
  const base = defaultState();
  const value = stored[STORE_KEY] || {};
  return {
    ...base,
    ...value,
    mapping: { ...base.mapping, ...(value.mapping || {}) },
    targets: { ...base.targets, ...(value.targets || {}) },
    mappingSession: { ...base.mappingSession, ...(value.mappingSession || {}) },
    panels: {
      aptiv: { ...base.panels.aptiv, ...((value.panels || {}).aptiv || {}) },
      aptivPoland: { ...base.panels.aptivPoland, ...((value.panels || {}).aptivPoland || {}) },
      brasilseg: { ...base.panels.brasilseg, ...((value.panels || {}).brasilseg || {}) }
    }
  };
}

/**
 * Persiste o estado e atualiza o ícone da toolbar.
 * @param {object} state - Estado a salvar.
 */
async function writeState(state) {
  await chrome.storage.local.set({ [STORE_KEY]: state });
  await updateActionIcon(state);
}

/**
 * Atualiza ícone e título da ação conforme o status geral derivado das regras.
 * @param {object} state - Estado atual.
 */
async function updateActionIcon(state) {
  const status = MonitorRules.deriveOverallStatus(state);
  try {
    await Promise.all([
      chrome.action.setIcon({ path: ACTION_ICONS[status] }),
      chrome.action.setTitle({ title: `Monitor de Backlog ServiceNow · ${ACTION_TITLES[status]}` })
    ]);
  } catch {
    // Mantém o ícone padrão do manifest se o Chrome recusar a atualização.
  }
}

/**
 * Garante que o alarme periódico existe com o intervalo configurado (ou limpa tudo se parado).
 * @param {object} state - Estado atual.
 */
async function ensureAlarm(state) {
  if (!state.running) {
    await chrome.alarms.clear(ALARM_NAME);
    await Promise.all(Object.keys(PANEL_INFO).map((operation) => chrome.alarms.clear(`${RECHECK_ALARM_PREFIX}${operation}`)));
    return;
  }
  const interval = Math.max(MIN_INTERVAL_MINUTES, Number(state.intervalMinutes) || 1);
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm || alarm.periodInMinutes !== interval) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
  }
}

/**
 * Token de sessão do navegador (storage.session) para invalidar mapeamentos de abas
 * após o Chrome reiniciar, já que os tab IDs podem ser reutilizados.
 * @returns {Promise<string>} Token da sessão atual.
 */
async function getBrowserSessionToken() {
  if (!sessionTokenPromise) {
    sessionTokenPromise = (async () => {
      const stored = await chrome.storage.session.get(SESSION_TOKEN_KEY);
      let token = stored[SESSION_TOKEN_KEY];
      if (!token) {
        token = crypto.randomUUID();
        await chrome.storage.session.set({ [SESSION_TOKEN_KEY]: token });
      }
      return token;
    })().catch((error) => {
      sessionTokenPromise = null;
      throw error;
    });
  }
  return sessionTokenPromise;
}

/**
 * Carrega (ou inicializa) a versão de ciclo persistida, para que ciclos em andamento
 * não sejam executados duas vezes mesmo se o service worker for encerrado e recriado.
 * @returns {Promise<number>} Versão de ciclo atual.
 */
async function loadCycleVersion() {
  const stored = await chrome.storage.session.get(CYCLE_VERSION_KEY);
  cycleVersion = Number(stored[CYCLE_VERSION_KEY]) || 0;
  return cycleVersion;
}

/**
 * Incrementa e persiste a versão de ciclo, invalidando ciclos antigos em andamento.
 * @returns {Promise<number>} Nova versão de ciclo.
 */
async function bumpCycleVersion() {
  cycleVersion += 1;
  await chrome.storage.session.set({ [CYCLE_VERSION_KEY]: cycleVersion });
  return cycleVersion;
}

/** util sleep */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Encurta mensagens de erro para exibição. */
function shortError(error) {
  return String(error?.message || error || "erro desconhecido").replace(/\s+/g, " ").slice(0, 130);
}

/** Define kind/status/detail de um painel de resultado. */
function setPanelResult(panel, kind, status, detail) {
  panel.kind = kind;
  panel.status = status;
  panel.detail = detail;
}
