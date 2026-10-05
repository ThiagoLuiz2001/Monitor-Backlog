const STORE_KEY = "monitorState";
const ACTIVITY_KEY = "panelInteractionTimes";
const ALARM_NAME = "service-now-backlog-check";
const RECHECK_ALARM_PREFIX = "service-now-foreground-recheck-";
const SESSION_TOKEN_KEY = "monitorBrowserSessionToken";
const MIN_INTERVAL_MINUTES = 0.5;
const RECENT_USE_MS = 2 * 60 * 1000;

const PANEL_INFO = {
  aptiv: { label: "APTIV", host: "aptiv.service-now.com" },
  aptivPoland: { label: "APTIV Polônia", host: "aptiv.service-now.com" },
  brasilseg: { label: "BRASILSEG", host: "brasilseg.service-now.com" }
};

let creatingOffscreenDocument;
let currentCycle;
let sessionTokenPromise;
let restoringMappings;
let lastRestoreScanAt = 0;

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

function defaultState() {
  return {
    running: false,
    intervalMinutes: 1,
    mapping: { aptiv: null, aptivPoland: null, brasilseg: null },
    targets: { aptiv: null, aptivPoland: null, brasilseg: null },
    mappingSession: { aptiv: null, aptivPoland: null, brasilseg: null },
    panels: { aptiv: makePanelState(), aptivPoland: makePanelState(), brasilseg: makePanelState() }
  };
}

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

async function writeState(state) {
  await chrome.storage.local.set({ [STORE_KEY]: state });
}

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

function tabIdentity(tab) {
  try {
    const url = new URL(tab.url || tab.pendingUrl || "");
    return { host: url.hostname, pathname: url.pathname, title: String(tab.title || "").replace(/\s+/g, " ").trim() };
  } catch {
    return null;
  }
}

function normalizeTitle(title) {
  return String(title || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isExpectedPanelTitle(operation, title) {
  const normalized = normalizeTitle(title);
  if (operation === "aptiv") return normalized.includes("capgemini aptiv sd dashboard");
  if (operation === "aptivPoland") return normalized.includes("backlog aptiv polonia");
  return normalized.includes("backlog service desk - copia");
}

function matchSavedTarget(operation, target, tabs) {
  if (!target?.host || !target?.pathname) return { tab: null, reason: "missing-target" };
  const candidates = tabs.filter((tab) => {
    const identity = tabIdentity(tab);
    return identity?.host === target.host && identity.host === PANEL_INFO[operation].host;
  });
  const exact = candidates.filter((tab) => {
    const identity = tabIdentity(tab);
    return identity.pathname === target.pathname && normalizeTitle(identity.title) === normalizeTitle(target.title);
  });
  if (exact.length === 1) return { tab: exact[0], reason: "matched" };
  if (exact.length > 1) return { tab: null, reason: "ambiguous" };
  const pathMatches = candidates.filter((tab) => tabIdentity(tab)?.pathname === target.pathname);
  if (!target.title && pathMatches.length === 1 && pathMatches[0].status !== "loading") return { tab: pathMatches[0], reason: "matched-path" };

  const titleMatches = candidates.filter((tab) => normalizeTitle(tabIdentity(tab)?.title) === normalizeTitle(target.title));
  if (target.title && titleMatches.length === 1) return { tab: titleMatches[0], reason: "matched-title" };
  if (candidates.some((tab) => tab.status === "loading")) return { tab: null, reason: "loading" };
  if (titleMatches.length > 1 || candidates.filter((tab) => tabIdentity(tab)?.pathname === target.pathname).length > 1) {
    return { tab: null, reason: "ambiguous" };
  }
  return { tab: null, reason: candidates.some((tab) => tab.status === "loading") ? "loading" : "not-found" };
}

async function restoreSavedMappings(force = false) {
  if (restoringMappings) return restoringMappings;
  if (!force && Date.now() - lastRestoreScanAt < 5000) return readState();
  restoringMappings = performMappingRestore().finally(() => { restoringMappings = null; });
  return restoringMappings;
}

async function performMappingRestore() {
  const [state, sessionToken] = await Promise.all([readState(), getBrowserSessionToken()]);
  const patterns = [...new Set(Object.values(PANEL_INFO).map(({ host }) => `https://${host}/*`))];
  const tabs = await chrome.tabs.query({ url: patterns });
  let changed = false;
  const restoredOperations = [];

  for (const operation of Object.keys(PANEL_INFO)) {
    const oldTabId = state.mapping[operation];
    const oldTarget = state.targets[operation];
    if (state.mappingSession[operation] === sessionToken && Number.isInteger(oldTabId)) {
      try {
        const currentTab = await chrome.tabs.get(oldTabId);
        if (tabIdentity(currentTab)?.host === PANEL_INFO[operation].host) {
          if (!oldTarget) {
            state.targets[operation] = tabIdentity(currentTab);
            state.panels[operation].status = "Aba restaurada";
            state.panels[operation].detail = "A identidade da aba foi salva; aguardando leitura do painel.";
            state.panels[operation].checkedAt = null;
            changed = true;
            restoredOperations.push(operation);
          }
          continue;
        }
      } catch {
        // The tab may have been closed; attempt to find its saved identity below.
      }
    }

    if (!oldTarget && Number.isInteger(oldTabId)) {
      const expectedLegacyTabs = tabs.filter((tab) => tabIdentity(tab)?.host === PANEL_INFO[operation].host && isExpectedPanelTitle(operation, tab.title));
      const legacyTab = expectedLegacyTabs.length === 1 ? expectedLegacyTabs[0] : null;
      if (legacyTab) {
        state.targets[operation] = tabIdentity(legacyTab);
        state.mapping[operation] = legacyTab.id;
        state.mappingSession[operation] = sessionToken;
        state.panels[operation].status = "Aba restaurada";
        state.panels[operation].detail = "A seleção anterior foi recuperada; aguardando leitura do painel.";
        state.panels[operation].checkedAt = null;
        changed = true;
        restoredOperations.push(operation);
        continue;
      }
      if (tabs.some((tab) => tabIdentity(tab)?.host === PANEL_INFO[operation].host && tab.status === "loading")) continue;
      if (expectedLegacyTabs.length > 1) {
        state.mapping[operation] = null;
        state.mappingSession[operation] = null;
        state.panels[operation].status = "Escolha de aba necessária";
        state.panels[operation].detail = "Há mais de uma aba que pode corresponder ao painel antigo. Escolha a correta no popup.";
        state.panels[operation].checkedAt = null;
        changed = true;
        continue;
      }
    }

    const target = state.targets[operation];
    if (!target) {
      if (Number.isInteger(state.mapping[operation])) {
        state.mapping[operation] = null;
        state.mappingSession[operation] = null;
        state.panels[operation].status = "Aba não disponível";
        state.panels[operation].detail = "Não foi possível identificar a seleção antiga. Escolha a aba do painel novamente.";
        state.panels[operation].checkedAt = null;
        changed = true;
      }
      continue;
    }

    const match = matchSavedTarget(operation, target, tabs);
    if (match.tab) {
      const reassigned = state.mapping[operation] !== match.tab.id || state.mappingSession[operation] !== sessionToken;
      state.mapping[operation] = match.tab.id;
      state.mappingSession[operation] = sessionToken;
      if (reassigned) {
        state.panels[operation].status = "Aba restaurada";
        state.panels[operation].detail = "A aba salva foi associada novamente; aguardando leitura do painel.";
        state.panels[operation].checkedAt = null;
        changed = true;
        restoredOperations.push(operation);
      }
    } else {
      if (state.mapping[operation] !== null || state.mappingSession[operation] !== null) {
        state.mapping[operation] = null;
        state.mappingSession[operation] = null;
        state.panels[operation].checkedAt = null;
        changed = true;
      }
      const label = target.title || PANEL_INFO[operation].label;
      const status = match.reason === "ambiguous"
        ? "Escolha de aba necessária"
        : match.reason === "loading" ? "Aba restaurando" : "Aba salva não aberta";
      const detail = match.reason === "ambiguous"
        ? `Mais de uma aba corresponde a “${label}”. Escolha a correta no popup.`
        : match.reason === "loading"
          ? `A aba salva “${label}” ainda está carregando; a extensão tentará reassociá-la quando terminar.`
          : `A aba salva “${label}” ainda não foi encontrada. Quando o Chrome a abrir, a extensão tentará associá-la; se necessário, selecione-a no popup.`;
      if (state.panels[operation].status !== status || state.panels[operation].detail !== detail) changed = true;
      state.panels[operation].status = status;
      state.panels[operation].detail = detail;
    }
  }

  if (changed) await writeState(state);
  if (state.running) {
    await Promise.all([...new Set(restoredOperations)].map((operation) =>
      chrome.alarms.create(`${RECHECK_ALARM_PREFIX}${operation}`, { delayInMinutes: MIN_INTERVAL_MINUTES })
    ));
  }
  lastRestoreScanAt = Date.now();
  return state;
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await readState();
  await writeState(state);
  await ensureAlarm(state);
  await restoreSavedMappings(true);
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await readState();
  await ensureAlarm(state);
  await restoreSavedMappings(true);
});

void (async () => {
  const state = await readState();
  await ensureAlarm(state);
  await restoreSavedMappings(true);
})();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runCycle();
  else if (alarm.name.startsWith(RECHECK_ALARM_PREFIX)) {
    const operation = alarm.name.slice(RECHECK_ALARM_PREFIX.length);
    if (operation in PANEL_INFO) runCycle(operation);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const sessionToken = await getBrowserSessionToken();
  let state = await readState();
  const needsRestore = Object.keys(PANEL_INFO).some((operation) =>
    state.targets[operation] && (state.mappingSession[operation] !== sessionToken || !Number.isInteger(state.mapping[operation]))
  );
  if (needsRestore) {
    await restoreSavedMappings(true);
    state = await readState();
  }
  let changed = false;
  for (const operation of Object.keys(PANEL_INFO)) {
      if (state.mapping[operation] === tabId && state.mappingSession[operation] === sessionToken) {
      state.panels[operation].lastSelectedAt = Date.now();
      changed = true;
      if (state.running) {
        await chrome.alarms.create(`${RECHECK_ALARM_PREFIX}${operation}`, { delayInMinutes: MIN_INTERVAL_MINUTES });
      }
    }
  }
  if (changed) await writeState(state);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    const host = tabIdentity(tab)?.host;
    if (Object.values(PANEL_INFO).some((panel) => panel.host === host)) void restoreSavedMappings(true);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

async function handleMessage(message, sender) {
  const state = await readState();
  switch (message.type) {
    case "GET_STATE":
      await restoreSavedMappings();
      return { state: await readState() };
    case "PANEL_INTERACTION": {
      const tabId = sender?.tab?.id;
      const senderHost = (() => {
        try { return new URL(sender?.url || "").hostname; } catch { return ""; }
      })();
      const operation = Object.keys(PANEL_INFO).find((key) => state.mapping[key] === tabId && PANEL_INFO[key].host === senderHost);
      const at = Number(message.at);
      if (operation && Number.isFinite(at) && Math.abs(Date.now() - at) < 60000) {
        const stored = await chrome.storage.local.get(ACTIVITY_KEY);
        const times = stored[ACTIVITY_KEY] || {};
        times[operation] = Math.max(Number(times[operation]) || 0, at);
        await chrome.storage.local.set({ [ACTIVITY_KEY]: times });
      }
      return {};
    }
    case "SET_MAPPING": {
      const operation = message.operation;
      if (!(operation in PANEL_INFO)) throw new Error("Operação inválida.");
      const tabId = message.tabId == null ? null : Number(message.tabId);
      if (tabId !== null && !Number.isInteger(tabId)) throw new Error("Aba inválida.");
      const conflictingOperation = tabId === null
        ? null
        : Object.keys(PANEL_INFO).find((key) => key !== operation && state.mapping[key] === tabId);
      if (conflictingOperation) throw new Error("Cada painel precisa usar uma aba diferente. Essa aba já está selecionada para outro painel.");
      const sessionToken = tabId === null ? null : await getBrowserSessionToken();
      let target = null;
      if (tabId !== null) {
        let selectedTab;
        try { selectedTab = await chrome.tabs.get(tabId); } catch { throw new Error("A aba selecionada não está mais disponível."); }
        target = tabIdentity(selectedTab);
        if (target?.host !== PANEL_INFO[operation].host) throw new Error("Selecione uma aba do domínio correto para este painel.");
      }
      if (state.mapping[operation] !== tabId) {
        state.panels[operation] = makePanelState();
        chrome.notifications.clear(`${operation}-backlog`).catch(() => {});
        const stored = await chrome.storage.local.get(ACTIVITY_KEY);
        const times = stored[ACTIVITY_KEY] || {};
        delete times[operation];
        await chrome.storage.local.set({ [ACTIVITY_KEY]: times });
      }
      state.mapping[operation] = tabId;
      state.targets[operation] = tabId === null ? null : target;
      state.mappingSession[operation] = sessionToken;
      state.panels[operation].lastSelectedAt = tabId === null ? null : Date.now();
      state.panels[operation].detail = tabId === null
        ? "Selecione a aba correta deste painel no popup."
        : "Aba selecionada; aguardando a próxima verificação.";
      await writeState(state);
      return { state };
    }
    case "SET_INTERVAL": {
      const interval = Number(message.intervalMinutes);
      if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MINUTES) {
        throw new Error("O intervalo mínimo aceito é 0,5 minuto (30 segundos).");
      }
      state.intervalMinutes = interval;
      await writeState(state);
      await ensureAlarm(state);
      return { state };
    }
    case "START":
      state.running = true;
      await writeState(state);
      await ensureAlarm(state);
      await runCycle();
      return { state: await readState() };
    case "STOP":
      state.running = false;
      await writeState(state);
      await ensureAlarm(state);
      return { state };
    case "CHECK_NOW":
      await runCycle();
      return { state: await readState() };
    case "TEST_SOUND":
      await playAlertSound();
      await showNotification("Teste do alerta", "Se você ouviu o som, a saída de áudio está funcionando.", "test");
      return {};
    default:
      throw new Error("Ação desconhecida.");
  }
}

async function runCycle(onlyOperation = null) {
  if (currentCycle) return currentCycle;
  currentCycle = performCycle(onlyOperation);
  try {
    await currentCycle;
  } finally {
    currentCycle = null;
  }
}

async function performCycle(onlyOperation = null) {
  await restoreSavedMappings();
  const state = await readState();
  if (!state.running) return;
  const checkedMapping = { ...state.mapping };
  const operations = onlyOperation && onlyOperation in PANEL_INFO ? [onlyOperation] : Object.keys(PANEL_INFO);

  for (const operation of operations) {
    await checkOperation(operation, state);
  }
  const latestState = await readState();
  for (const operation of operations) {
    if (latestState.mapping[operation] === checkedMapping[operation]) {
      const latestPanel = latestState.panels[operation];
      latestState.panels[operation] = {
        ...state.panels[operation],
        lastSelectedAt: Math.max(Number(state.panels[operation].lastSelectedAt) || 0, Number(latestPanel.lastSelectedAt) || 0) || null,
        lastRefreshAt: Math.max(Number(state.panels[operation].lastRefreshAt) || 0, Number(latestPanel.lastRefreshAt) || 0) || null
      };
    }
  }
  await writeState(latestState);
}

async function checkOperation(operation, state) {
  const now = Date.now();
  const panel = state.panels[operation];
  const tabId = state.mapping[operation];
  panel.checkedAt = now;
  panel.freshness = "";

  // Tab IDs can be reused after Chrome restarts. Never inspect one until its
  // saved identity has been re-associated in the current browser session.
  if (Number.isInteger(tabId) && state.mappingSession[operation] !== await getBrowserSessionToken()) {
    setPanelResult(panel, "unknown", "Aba restaurando", "A seleção salva ainda está sendo associada à aba correta. O monitor tentará novamente.");
    return;
  }

  if (!Number.isInteger(tabId)) {
    setPanelResult(panel, "unknown", "Aba não disponível", "Escolha uma aba aberta deste painel no popup.");
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    setPanelResult(panel, "unknown", "Aba não disponível", "A aba escolhida foi fechada. Selecione outra aba do ServiceNow.");
    return;
  }

  let tabUrl;
  try {
    tabUrl = new URL(tab.url || tab.pendingUrl || "");
  } catch {
    setPanelResult(panel, "unknown", "Aba não disponível", "A aba não tem um endereço legível do ServiceNow.");
    return;
  }
  if (tabUrl.hostname !== PANEL_INFO[operation].host) {
    setPanelResult(panel, "unknown", "Aba não disponível", "A aba escolhida não pertence ao domínio deste painel. Selecione outra.");
    return;
  }
  if (tab.discarded) {
    setPanelResult(panel, "unknown", "Aba suspensa", "Abra a aba do ServiceNow para que o Chrome a carregue novamente.");
    return;
  }
  if (tab.status === "loading") {
    setPanelResult(panel, "unknown", "Página carregando", "Aguarde a conclusão do carregamento; o monitor tentará novamente.");
    return;
  }
  if (/^(chrome-error|chrome:\/\/newtab)/i.test(tab.url || "")) {
    setPanelResult(panel, "unknown", "Erro na página", "O Chrome não disponibilizou conteúdo legível para esta aba.");
    return;
  }

  let frames;
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: collectPanelFrame,
      args: [operation]
    });
  } catch (error) {
    setPanelResult(panel, "unknown", "Falha de leitura", `O Chrome não conseguiu ler esta página: ${shortError(error)}.`);
    return;
  }

  const readings = (frames || []).map((frame) => frame.result).filter((result) => result && result.allowedHost);
  if (!readings.length) {
    setPanelResult(panel, "unknown", "Falha de leitura", "Nenhum conteúdo acessível foi encontrado no domínio autorizado.");
    return;
  }

  if (readings.some((reading) => reading.sessionExpired)) {
    setPanelResult(panel, "unknown", "Sessão expirada", "Entre novamente na própria aba do ServiceNow. A extensão não pede nem guarda credenciais.");
    return;
  }
  if (readings.some((reading) => reading.pageError)) {
    setPanelResult(panel, "unknown", "Erro na página", "A página exibiu um erro em vez do painel. Verifique a própria aba do ServiceNow.");
    return;
  }
  if (readings.some((reading) => reading.loading)) {
    setPanelResult(panel, "unknown", "Página carregando", "O conteúdo do painel ainda está carregando; o monitor tentará novamente.");
    return;
  }
  const storedActivity = await chrome.storage.local.get(ACTIVITY_KEY);
  const lastPersistedInteraction = Number(storedActivity[ACTIVITY_KEY]?.[operation]) || 0;
  const lastInteraction = Math.max(lastPersistedInteraction, 0, ...readings.map((reading) => Number(reading.lastInteraction) || 0));
  if (readings.every((reading) => reading.noReadableContent)) {
    const detail = operation === "brasilseg"
      ? "A aba não expôs texto legível. Isso não será interpretado como ausência de chamados."
      : operation === "aptivPoland"
        ? "A lista não expôs texto legível. Isso não será interpretado como uma lista sem chamados."
      : "A aba está em branco ou não expôs texto. O monitor tentará uma recuperação em segundo plano após o período seguro; se persistir, confira a própria aba do ServiceNow.";
    setPanelResult(panel, "unknown", "Página sem conteúdo legível", detail);
    if (!Number.isFinite(panel.lastSelectedAt) && !Number.isFinite(tab.lastAccessed)) panel.lastSelectedAt = now;
    if (operation === "brasilseg") {
      await maybeClickBrasilsegRefresh(tab, panel, now, lastInteraction, panel.lastSelectedAt, state.intervalMinutes);
    } else {
      await maybeRefreshAfterIdle(tab, panel, now, false, lastInteraction, panel.lastSelectedAt, true, state.intervalMinutes);
    }
    return;
  }

  if (operation === "aptivPoland") {
    await checkPolandOperation(tab, panel, state, now, readings, lastInteraction);
    return;
  }

  const result = operation === "aptiv" ? combineAptiv(readings) : combineBrasilseg(readings);
  if (!result) {
    setPanelResult(panel, "unknown", "Falha de leitura", "O indicador esperado não foi encontrado no conteúdo acessível da página.");
    if (operation === "brasilseg") {
      await maybeClickBrasilsegRefresh(tab, panel, now, lastInteraction, panel.lastSelectedAt, state.intervalMinutes);
    } else {
      panel.freshness = "A recarga automática foi suspensa porque o indicador não pôde ser lido com confiança.";
    }
    return;
  }

  setPanelResult(panel, result.kind, result.status, result.detail);
  const marker = readings.map((reading) => reading.refreshMarker).filter(Boolean).sort().join(" | ");
  const fingerprint = JSON.stringify({
    kind: result.kind,
    value: result.value ?? null,
    sections: result.sections?.map((section) => [section.name, section.kind]) ?? null,
    marker
  });
  const contentChanged = Boolean(panel.fingerprint && panel.fingerprint !== fingerprint);
  panel.fingerprint = fingerprint;

  if (result.kind === "backlog" && !panel.alertActive) {
    panel.alertActive = true;
    emitBacklogAlert(operation, result.detail);
  } else if (result.kind === "empty") {
    panel.alertActive = false;
    chrome.notifications.clear(`${operation}-backlog`).catch(() => {});
  }

  if (result.kind === "unknown") {
    if (operation === "brasilseg") {
      await maybeClickBrasilsegRefresh(tab, panel, now, lastInteraction, panel.lastSelectedAt, state.intervalMinutes);
    } else {
      panel.freshness = "A recarga automática foi suspensa porque a leitura ficou inconclusiva.";
    }
  } else {
    if (!Number.isFinite(panel.lastSelectedAt) && !Number.isFinite(tab.lastAccessed)) {
      panel.lastSelectedAt = now;
    }
    if (operation === "brasilseg") {
      await maybeClickBrasilsegRefresh(tab, panel, now, lastInteraction, panel.lastSelectedAt, state.intervalMinutes);
    } else {
      await maybeRefreshAfterIdle(tab, panel, now, contentChanged, lastInteraction, panel.lastSelectedAt);
    }
  }
}

async function checkPolandOperation(tab, panel, state, now, readings, lastInteraction) {
  const lists = readings.map((reading) => reading.polandList).filter(Boolean);
  const visibleCallerIds = [...new Set(lists.flatMap((list) => list.sysIds || []))];
  const listFound = lists.some((list) => list.found);
  const listLoading = lists.some((list) => list.loading);
  const emptyMessage = lists.some((list) => list.emptyMessage);
  const visibleRows = Math.max(0, ...lists.map((list) => Number(list.rowCount) || 0));
  const missingCallerRows = Math.max(0, ...lists.map((list) => Number(list.missingCallerRows) || 0));
  let result;

  if (!listFound) {
    result = { kind: "unknown", status: "Lista não reconhecida", detail: "Não encontrei com segurança a coluna Caller na lista. Nenhuma conclusão foi feita sobre a origem dos chamados." };
  } else if (!visibleCallerIds.length) {
    if (!listLoading && visibleRows === 0 && emptyMessage) {
      result = { kind: "empty", status: "Sem chamados visíveis", detail: "A lista reconhecida não contém chamados visíveis." };
    } else {
      result = {
        kind: "unknown",
        status: listLoading ? "Lista carregando" : "Leitura inconclusiva",
        detail: visibleRows > 0
          ? "Há linhas na lista, mas não foi possível ler os links de Caller em todas elas."
          : "A lista ainda não confirmou se está vazia. A extensão não vai presumir que não há chamados."
      };
    }
  } else {
    let lookup;
    try {
      const frames = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: lookupPolandCallerOrigins,
        args: [visibleCallerIds]
      });
      lookup = frames?.[0]?.result;
    } catch (error) {
      lookup = { status: "error", error: shortError(error) };
    }

    if (lookup?.status === "session-expired" && Number(lookup.matchCount) > 0) {
      result = {
        kind: "backlog",
        status: "Chamado do Brasil/Portugal detectado",
        detail: "Há pelo menos um chamado visível cujo usuário pertence ao Brasil ou a Portugal.",
        value: lookup.matchCount
      };
    } else if (lookup?.status === "session-expired") {
      result = { kind: "unknown", status: "Sessão expirada", detail: "A consulta dos perfis pediu autenticação. Entre novamente na própria aba do ServiceNow." };
    } else if (!lookup || lookup.status !== "ok") {
      result = { kind: "unknown", status: "Consulta de usuários inconclusiva", detail: `Não consegui consultar os perfis dos solicitantes${lookup?.error ? `: ${lookup.error}` : "."} Confira a própria aba do ServiceNow.` };
    } else if (lookup.matchCount > 0) {
      result = {
        kind: "backlog",
        status: "Chamado do Brasil/Portugal detectado",
        detail: "Há pelo menos um chamado visível cujo usuário pertence ao Brasil ou a Portugal.",
        value: lookup.matchCount
      };
    } else if (lookup.failedCount > 0 || missingCallerRows > 0 || listLoading) {
      result = {
        kind: "unknown",
        status: "Consulta de usuários inconclusiva",
        detail: "Não foi possível confirmar a origem de todos os chamados visíveis. A extensão não os considera de outro país e continuará atualizando a lista para procurar novos chamados."
      };
    } else {
      result = { kind: "empty", status: "Sem chamado do Brasil/Portugal", detail: "Nenhum chamado visível foi associado a um usuário do Brasil ou de Portugal." };
    }
  }

  const selectedState = await readState();
  const activeSessionToken = await getBrowserSessionToken();
  if (selectedState.mapping.aptivPoland !== tab.id || selectedState.mappingSession.aptivPoland !== activeSessionToken) return;

  setPanelResult(panel, result.kind, result.status, result.detail);
  const marker = readings.map((reading) => reading.refreshMarker).filter(Boolean).sort().join(" | ");
  const fingerprint = JSON.stringify({ kind: result.kind, value: result.value ?? null, marker });
  const contentChanged = Boolean(panel.fingerprint && panel.fingerprint !== fingerprint);
  panel.fingerprint = fingerprint;

  if (result.kind === "backlog" && !panel.alertActive) {
    panel.alertActive = true;
    emitBacklogAlert("aptivPoland", result.detail);
  } else if (result.kind === "empty") {
    panel.alertActive = false;
    chrome.notifications.clear("aptivPoland-backlog").catch(() => {});
  }

  if (result.kind === "unknown" && result.status === "Sessão expirada") {
    panel.freshness = "Entre novamente na própria aba do ServiceNow para retomar a consulta.";
    return;
  }
  if (!Number.isFinite(panel.lastSelectedAt) && !Number.isFinite(tab.lastAccessed)) panel.lastSelectedAt = now;
  const [latestState, activity] = await Promise.all([readState(), chrome.storage.local.get(ACTIVITY_KEY)]);
  if (latestState.mapping.aptivPoland !== tab.id || latestState.mappingSession.aptivPoland !== activeSessionToken) return;
  let currentTab;
  try {
    currentTab = await chrome.tabs.get(tab.id);
  } catch {
    panel.freshness = "A aba foi fechada antes de poder ser atualizada.";
    return;
  }
  const latestLastSelectedAt = Math.max(Number(panel.lastSelectedAt) || 0, Number(latestState.panels.aptivPoland.lastSelectedAt) || 0);
  const latestInteraction = Math.max(Number(lastInteraction) || 0, Number(activity[ACTIVITY_KEY]?.aptivPoland) || 0);
  await maybeRefreshAfterIdle(currentTab, panel, Date.now(), contentChanged, latestInteraction, latestLastSelectedAt, false, state.intervalMinutes);
}

async function lookupPolandCallerOrigins(sysIds) {
  if (location.hostname.toLowerCase() !== "aptiv.service-now.com") return { status: "error" };
  const validIds = [...new Set((Array.isArray(sysIds) ? sysIds : []).filter((id) => /^[a-f0-9]{32}$/i.test(String(id))))];
  if (!validIds.length) return { status: "ok", matchCount: 0, failedCount: 0 };

  const directoryMarkers = ["OU=BR", "OU=PT", "OU=BRAZIL", "OU=PORTUGAL"];
  let matchCount = 0;
  let failedCount = 0;
  let sessionExpired = false;

  async function checkOne(sysId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/sys_user.do?sys_id=${encodeURIComponent(sysId)}`, {
        credentials: "same-origin",
        redirect: "follow",
        referrerPolicy: "origin",
        signal: controller.signal,
        headers: { Accept: "text/html" }
      });
      const finalUrl = new URL(response.url, location.href);
      if (/login|signin|oauth|sso/i.test(finalUrl.pathname) || response.status === 401) {
        return { status: "session-expired" };
      }
      if (!response.ok || finalUrl.hostname !== location.hostname || !/\/sys_user\.do$/i.test(finalUrl.pathname)) {
        return { status: "error" };
      }
      const htmlText = await response.text();
      const profile = new DOMParser().parseFromString(htmlText, "text/html");
      const profileText = `${profile.title || ""} ${profile.body?.textContent || ""}`;
      const expiredMessage = /session (has )?expired|sess[aã]o expirada|sess[aã]o expirou/i.test(profileText);
      const loginForm = profile.querySelector('input[type="password"]') && /sign in|log in|login\.do|entrar|autentica[cç][aã]o/i.test(profileText);
      if (expiredMessage || loginForm) {
        return { status: "session-expired" };
      }
      const inputs = [...profile.querySelectorAll("input[value]")];
      if (!inputs.length || /access denied|not authorized|permission denied|record not found|no record found|acesso negado|registro n[aã]o encontrado/i.test(profile.body?.textContent || "")) {
        return { status: "error" };
      }
      const values = inputs.map((input) => String(input.value || input.getAttribute("value") || "").toUpperCase());
      return {
        status: "ok",
        match: values.some((value) => directoryMarkers.some((marker) => value.includes(marker))),
        hasDirectoryInfo: values.some((value) => value.includes("OU="))
      };
    } catch {
      return { status: "error" };
    } finally {
      clearTimeout(timer);
    }
  }

  for (let index = 0; index < validIds.length; index += 4) {
    const batch = await Promise.all(validIds.slice(index, index + 4).map(checkOne));
    for (const result of batch) {
      if (result.status === "session-expired") sessionExpired = true;
      else if (result.status !== "ok") failedCount += 1;
      else if (result.match) matchCount += 1;
      else if (!result.hasDirectoryInfo) failedCount += 1;
    }
  }
  return sessionExpired
    ? { status: "session-expired", matchCount, failedCount }
    : { status: "ok", matchCount, failedCount };
}

function setPanelResult(panel, kind, status, detail) {
  panel.kind = kind;
  panel.status = status;
  panel.detail = detail;
}

function shortError(error) {
  return String(error?.message || error || "erro desconhecido").replace(/\s+/g, " ").slice(0, 130);
}

async function maybeRefreshAfterIdle(tab, panel, now, contentChanged, lastInteraction, lastSelectedAt, recovery = false, intervalMinutes = 1) {
  if (tab.status === "loading") {
    panel.freshness = "Recarga adiada: a página ainda está carregando.";
    return;
  }
  const selectedAt = Math.max(Number(lastSelectedAt) || 0, Number(tab.lastAccessed) || 0);
  const activityAt = Number(lastInteraction) || 0;
  const recentlySelected = selectedAt > 0 && now - selectedAt < RECENT_USE_MS;
  const recentlyInteracted = activityAt > 0 && now - activityAt < RECENT_USE_MS;
  if (recentlySelected || recentlyInteracted) {
    const reason = recentlyInteracted
      ? "houve interação com o painel nos últimos dois minutos"
      : "a aba foi selecionada há menos de dois minutos";
    panel.freshness = `Recarga adiada porque ${reason}; nova tentativa no próximo ciclo. A aba pode continuar aberta: sem interação recente, ela poderá ser atualizada em segundo plano.${contentChanged ? " O conteúdo visível mudou desde a última verificação." : ""}`;
    return;
  }
  const recoveryCooldownMs = Math.max(5 * 60 * 1000, (Number(intervalMinutes) || 1) * 60 * 1000);
  if (recovery && Number(panel.lastRefreshAt) > 0 && now - Number(panel.lastRefreshAt) < recoveryCooldownMs) {
    const waitMinutes = Math.max(1, Math.ceil((recoveryCooldownMs - (now - Number(panel.lastRefreshAt))) / 60000));
    panel.freshness = `A página segue sem conteúdo legível. A próxima tentativa de recuperação será em cerca de ${waitMinutes} min.`;
    return;
  }
  try {
    await chrome.tabs.reload(tab.id);
    panel.lastRefreshAt = now;
    panel.freshness = recovery
      ? "A página estava sem conteúdo; tentei recarregá-la em segundo plano. O estado continua inconclusivo até surgir conteúdo legível."
      : `Recarga em segundo plano solicitada após a leitura; a próxima verificação lerá a página atualizada.${contentChanged ? " O conteúdo visível mudou desde a última verificação." : ""}`;
  } catch (error) {
    if (recovery) panel.lastRefreshAt = now;
    panel.freshness = `Não foi possível recarregar a aba em segundo plano: ${shortError(error)}.`;
  }
}

async function maybeClickBrasilsegRefresh(tab, panel, now, lastInteraction, lastSelectedAt, intervalMinutes = 1) {
  if (tab.status === "loading") {
    panel.freshness = "Clique no botão do ServiceNow adiado: a página ainda está carregando.";
    return;
  }
  const selectedAt = Math.max(Number(lastSelectedAt) || 0, Number(tab.lastAccessed) || 0);
  const activityAt = Number(lastInteraction) || 0;
  const recentlySelected = selectedAt > 0 && now - selectedAt < RECENT_USE_MS;
  const recentlyInteracted = activityAt > 0 && now - activityAt < RECENT_USE_MS;
  if (recentlySelected || recentlyInteracted) {
    const reason = recentlyInteracted
      ? "houve interação com o painel nos últimos dois minutos"
      : "a aba foi selecionada há menos de dois minutos";
    panel.freshness = `Clique no botão do ServiceNow adiado porque ${reason}; nova tentativa no próximo ciclo.`;
    return;
  }

  const minClickIntervalMs = Math.max(MIN_INTERVAL_MINUTES * 60 * 1000, (Number(intervalMinutes) || 1) * 60 * 1000);
  const elapsedSinceRefresh = now - (Number(panel.lastRefreshAt) || 0);
  if (panel.lastRefreshAt && elapsedSinceRefresh < minClickIntervalMs) {
    const waitSeconds = Math.max(1, Math.ceil((minClickIntervalMs - elapsedSinceRefresh) / 1000));
    panel.freshness = `O botão já foi acionado neste intervalo; a próxima tentativa será em cerca de ${waitSeconds} s.`;
    return;
  }

  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: clickBrasilsegRefreshButton
    });
    const result = frames?.[0]?.result;
    if (result?.status === "clicked") {
      panel.lastRefreshAt = now;
      panel.freshness = "Botão de atualização do painel acionado em segundo plano; a próxima verificação lerá os dados atualizados.";
    } else if (result?.status === "ambiguous") {
      panel.freshness = "Encontrei mais de um botão de atualização possível no painel; não cliquei para evitar uma ação errada.";
    } else if (result?.status === "not-found") {
      panel.freshness = "Não encontrei o botão de atualização do painel no DOM; não cliquei e não recarreguei a página.";
    } else if (result?.status === "disabled") {
      panel.freshness = "O botão de atualização do ServiceNow está desabilitado; tentarei novamente no próximo ciclo.";
    } else if (result?.status === "not-dashboard") {
      panel.freshness = "Não confirmei as seções Reação e Resolução nesta aba; nenhum botão foi acionado.";
    } else if (result?.status === "loading") {
      panel.freshness = "O documento ainda está carregando; tentarei o botão do ServiceNow no próximo ciclo.";
    } else {
      panel.freshness = "Não foi possível confirmar o botão de atualização do ServiceNow; a página não foi recarregada.";
    }
  } catch (error) {
    panel.freshness = `Não consegui acionar o botão do ServiceNow em segundo plano: ${shortError(error)}. A página não foi recarregada.`;
  }
}

function clickBrasilsegRefreshButton() {
  if (location.hostname.toLowerCase() !== "brasilseg.service-now.com") return { status: "not-dashboard" };
  if (document.readyState !== "complete") return { status: "loading" };

  const normalize = (value) => String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const elements = [];
  const textParts = [];
  const visited = new Set();
  function walk(node) {
    if (!node || visited.has(node)) return;
    visited.add(node);
    if (node.nodeType === 3) {
      if (node.nodeValue?.trim()) textParts.push(node.nodeValue);
      return;
    }
    if (node.nodeType === 1) {
      elements.push(node);
      if (node.localName === "slot") {
        const assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) {
          for (const child of assigned) walk(child);
          return;
        }
      }
      if (node.shadowRoot) {
        for (const child of node.shadowRoot.childNodes) walk(child);
      }
    }
    for (const child of node.childNodes || []) walk(child);
  }
  walk(document.body);

  const pageText = normalize(textParts.join(" "));
  if (!pageText.includes("reacao") || !pageText.includes("resolucao")) return { status: "not-dashboard" };

  const controls = elements.filter((element) => {
    if (!element.matches?.("button, [role='button'], a[href], [tabindex]:not([tabindex='-1'])")) return false;
    const style = getComputedStyle(element);
    if (element.hidden || style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || !element.getClientRects().length) return false;
    const names = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-tooltip"),
      element.getAttribute("data-original-title"),
      element.getAttribute("data-action"),
      element.getAttribute("name"),
      element.id,
      element.innerText,
      element.textContent
    ].map(normalize).filter(Boolean).join(" ");
    return /\b(refresh|atualizar|atualizacao|recarregar|reload|update)\b/.test(names);
  });
  const uniqueControls = controls.filter((element, index) => controls.indexOf(element) === index);
  if (!uniqueControls.length) return { status: "not-found" };
  if (uniqueControls.length !== 1) return { status: "ambiguous" };
  const button = uniqueControls[0];
  if (button.disabled || button.getAttribute("aria-disabled") === "true") return { status: "disabled" };
  button.click();
  return { status: "clicked" };
}

function combineAptiv(readings) {
  const matches = readings.filter((reading) => Number.isInteger(reading.aptivValue));
  if (!matches.length) return null;
  const values = [...new Set(matches.map((reading) => reading.aptivValue))];
  if (values.length !== 1) return null;
  const value = values[0];
  return value > 0
    ? { kind: "backlog", status: "Backlog detectado", detail: `Not Assigned - Brazil: ${value}`, value }
    : { kind: "empty", status: "Sem backlog", detail: "Not Assigned - Brazil: 0", value };
}

function combineBrasilseg(readings) {
  const sections = ["Reação", "Resolução"].map((name) => {
    const matching = readings.flatMap((reading) => reading.sections || []).filter((section) => section && section.name === name);
    const kinds = [...new Set(matching.map((section) => section.kind))];
    if (kinds.includes("backlog")) return { name, kind: "backlog" };
    if (kinds.includes("loading")) return { name, kind: "loading" };
    if (kinds.includes("empty")) return { name, kind: "empty" };
    return { name, kind: "unknown" };
  });
  const positive = sections.filter((section) => section.kind === "backlog").map((section) => section.name);
  if (positive.length) {
    return { kind: "backlog", status: "Backlog detectado", detail: `${positive.join(" e ")} exibe dados`, sections };
  }
  const loading = sections.filter((section) => section.kind === "loading").map((section) => section.name);
  if (loading.length) {
    const unknown = sections.filter((section) => section.kind === "unknown").map((section) => section.name);
    const suffix = unknown.length ? ` ${unknown.join(" e ")} ainda não pôde ser lida.` : "";
    return { kind: "unknown", status: "Dashboard carregando", detail: `${loading.join(" e ")} ainda mostra indicador de carregamento.${suffix} Será verificado novamente.`, sections };
  }
  if (sections.every((section) => section.kind === "empty")) {
    return { kind: "empty", status: "Sem backlog", detail: "Reação e Resolução sem linhas ou chamados.", sections };
  }
  const descriptions = sections.map((section) => {
    if (section.kind === "empty") return `${section.name}: mensagem de ausência de dados detectada`;
    if (section.kind === "backlog") return `${section.name}: dados detectados`;
    return `${section.name}: conteúdo não reconhecido`;
  });
  return { kind: "unknown", status: "Leitura inconclusiva", detail: `${descriptions.join("; ")}. Confira o conteúdo da própria aba.`, sections };
}

async function collectPanelFrame(operation) {
  const expectedHost = operation === "brasilseg" ? "brasilseg.service-now.com" : "aptiv.service-now.com";
  const host = location.hostname.toLowerCase();
  const allowedHost = host === expectedHost;
  if (!allowedHost) return { allowedHost: false };

  // Classic ServiceNow lists often populate their rows shortly after the page load.
  // Match the delay used by the user's working console script before inspecting them.
  if (operation === "aptivPoland") await new Promise((resolve) => setTimeout(resolve, 1500));

  const body = document.body;
  const bodyText = body ? readDeepText(body).slice(0, 30000) : "";
  const title = document.title || "";
  const pageText = `${location.href} ${title} ${bodyText.slice(0, 5000)}`;
  const normalizedText = normalize(pageText);
  const hasPasswordField = Boolean(document.querySelector('input[type="password"]'));
  const sessionExpired = /session (has )?expired|sess[aã]o expirada|sess[aã]o expirou|login\.do/i.test(pageText)
    || (hasPasswordField && /sign in|log in|login|entrar|autentica[cç][aã]o/i.test(normalizedText));
  const pageError = /this site can.t be reached|err_name_not_resolved|err_connection|n[aã]o [ée] poss[ií]vel acessar esse site/i.test(pageText)
    || /^(site n[aã]o pode ser acessado|n[aã]o foi poss[ií]vel acessar)/i.test(title);
  const refreshMarkerMatch = bodyText.match(/(?:[úu]ltima atualiza[cç][aã]o|last updated)\s*:?\s*([^\n\r]{1,80})/i);
  const refreshMarker = refreshMarkerMatch ? normalize(refreshMarkerMatch[0]) : "";
  const base = {
    allowedHost: true,
    loading: document.readyState !== "complete",
    sessionExpired,
    pageError,
    refreshMarker
  };
  if (!body || !normalize(bodyText)) return { ...base, noReadableContent: true };

  if (!sessionExpired && !pageError) {
    base.lastInteraction = trackDashboardActivity();
  }

  if (operation === "aptivPoland") {
    return { ...base, polandList: findPolandList(body) };
  }
  if (operation === "aptiv") {
    const value = findAptivValue(body);
    return { ...base, aptivValue: value };
  }
  return { ...base, sections: [findBrasilSection(body, "Reação"), findBrasilSection(body, "Resolução")] };

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function isVisible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    return !element.hidden && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function textOf(element) {
    return normalize(element ? readDeepText(element) : "");
  }

  function composedChildren(node) {
    if (node?.nodeType === 1 && node.localName === "slot") {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    if (node?.nodeType === 1 && node.shadowRoot) return [...node.shadowRoot.childNodes];
    return [...(node?.childNodes || [])];
  }

  function readDeepText(root) {
    const parts = [];
    const visited = new Set();
    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 3) {
        if (node.nodeValue?.trim()) parts.push(node.nodeValue);
        return;
      }
      if (node.nodeType === 1) {
        if (!isVisible(node) || /^(script|style|noscript|template)$/.test(node.localName)) return;
      }
      for (const child of composedChildren(node)) walk(child);
    }
    walk(root);
    return parts.join(" ");
  }

  function deepElements(root) {
    const elements = [];
    const visited = new Set();
    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 1 && node !== root) {
        if (!isVisible(node)) return;
        elements.push(node);
      }
      for (const child of composedChildren(node)) walk(child);
    }
    walk(root);
    return elements;
  }

  function parentAcrossShadow(element) {
    if (element?.parentElement) return element.parentElement;
    const rootNode = element?.getRootNode?.();
    return rootNode?.host || null;
  }

  function textAnchors(root, expected) {
    const found = [];
    const visited = new Set();
    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 3) {
        if (normalize(node.nodeValue).includes(expected) && node.parentElement && isVisible(node.parentElement)) {
          found.push(node.parentElement);
        }
        return;
      }
      if (node.nodeType === 1 && !isVisible(node)) return;
      for (const child of composedChildren(node)) walk(child);
    }
    walk(root);
    return [...new Set(found)];
  }

  function numericText(value) {
    const stripped = String(value || "").replace(/\s/g, "");
    if (!/^-?\d+$/.test(stripped) && !/^-?\d{1,3}(?:[.,]\d{3})+$/.test(stripped)) return null;
    return Number.parseInt(stripped.replace(/[^\d-]/g, ""), 10);
  }

  function findAptivValue(root) {
    const label = "not assigned - brazil";
    const anchors = textAnchors(root, label);
    for (const anchor of anchors) {
      let container = anchor;
      for (let depth = 0; depth < 9 && container; depth += 1, container = parentAcrossShadow(container)) {
        if (!isVisible(container) || !textOf(container).includes(label)) continue;
        const nodes = [container, ...deepElements(container)]
          .filter((element) => isVisible(element) && !composedChildren(element).some((child) => child.nodeType === 1 && isVisible(child)))
          .map((element) => ({ element, value: numericText(readDeepText(element)) }))
          .filter((item) => Number.isInteger(item.value));
        const values = [...new Set(nodes.map((item) => item.value))];
        if (values.length === 1) return values[0];
        if (values.length > 1) {
          const ranked = nodes.map((item) => {
            const size = Number.parseFloat(getComputedStyle(item.element).fontSize) || 0;
            return { ...item, size };
          }).sort((a, b) => b.size - a.size);
          if (ranked.length && ranked[0].size > (ranked[1]?.size || 0) * 1.25) return ranked[0].value;
        }
      }
    }
    const flat = normalize(readDeepText(root));
    const plainMatch = flat.match(/not assigned - brazil\s*:?\s*(-?\d+)/);
    return plainMatch ? Number.parseInt(plainMatch[1], 10) : null;
  }

  function findBrasilSection(root, name) {
    const wanted = normalize(name);
    const opposite = wanted === "reacao" ? "resolucao" : "reacao";
    const noData = ["nao ha dados disponiveis", "no data available", "no records to display", "no records found"];
    const anchors = [...new Set([
      ...textAnchors(root, wanted),
      ...deepElements(root).filter((element) => textOf(element) === wanted)
    ])].filter((element) => {
      const text = textOf(element);
      return text === wanted;
    });
    if (!anchors.length) return null;
    for (const anchor of anchors) {
      let container = anchor;
      for (let depth = 0; depth < 12 && container; depth += 1, container = parentAcrossShadow(container)) {
        const sectionText = textAfterAnchor(container, anchor, opposite);
        if (!sectionText) continue;
        const containerText = textOf(container);
        if (!containerText.includes(opposite) && hasLoadingIndicator(container)) {
          return { name, kind: "loading" };
        }
        if (/\b(?:inc|req|ritm|sctask|task)\s*\d{5,}\b/i.test(sectionText)) {
          return { name, kind: "backlog" };
        }
        if (hasDataRows(container, sectionText)) return { name, kind: "backlog" };
        if (!containerText.includes(opposite) && hasChartData(container)) return { name, kind: "backlog" };
        if (noData.some((phrase) => sectionText.includes(phrase))) return { name, kind: "empty" };
      }
    }
    return { name, kind: "unknown" };
  }

  function textAfterAnchor(container, anchor, opposite) {
    const marker = "__sn_section_anchor_83917__";
    const parts = [];
    const visited = new Set();
    let marked = false;
    function walk(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === 3) {
        if (node.nodeValue?.trim()) parts.push(node.nodeValue);
        return;
      }
      if (node.nodeType === 1 && !isVisible(node)) return;
      for (const child of composedChildren(node)) walk(child);
      if (node === anchor) {
        parts.push(marker);
        marked = true;
      }
    }
    walk(container);
    if (!marked) return "";
    const text = normalize(parts.join(" "));
    const start = text.indexOf(normalize(marker));
    if (start < 0) return "";
    const content = text.slice(start + normalize(marker).length);
    const boundaries = [opposite, "tarefas", "analise violados"]
      .map((boundary) => content.indexOf(boundary))
      .filter((index) => index >= 0);
    const end = Math.min(content.length, 5000, ...(boundaries.length ? boundaries : [content.length]));
    return content.slice(0, end);
  }

  function hasDataRows(container, sectionText) {
    const elements = deepElements(container);
    const rows = elements.filter((row) => row.localName === "tr" || row.getAttribute("role") === "row").filter((row) => {
      if (!isVisible(row)) return false;
      const cells = deepElements(row).filter((cell) => cell.localName === "td" || ["cell", "gridcell"].includes(cell.getAttribute("role")));
      const rowText = textOf(row);
      return cells.length >= 2 && rowText.length > 0 && sectionText.includes(rowText);
    });
    return rows.length > 0;
  }

  function hasChartData(container) {
    const elements = deepElements(container);
    return elements.some((element) => {
      const classes = typeof element.className === "string"
        ? element.className.toLowerCase()
        : String(element.className?.baseVal || "").toLowerCase();
      if (classes.includes("highcharts-point") || classes.includes("series-point")) return true;
      if (element.localName !== "path" || !element.getAttribute("d")) return false;
      let parent = parentAcrossShadow(element);
      while (parent && parent !== container) {
        const parentClasses = typeof parent.className === "string"
          ? parent.className.toLowerCase()
          : String(parent.className?.baseVal || "").toLowerCase();
        if (parentClasses.includes("highcharts-series") || parentClasses.includes("data-series")) return true;
        parent = parentAcrossShadow(parent);
      }
      return false;
    });
  }

  function hasLoadingIndicator(container) {
    const elements = [container, ...deepElements(container)];
    return elements.some((element) => {
      if (!isVisible(element)) return false;
      const role = String(element.getAttribute?.("role") || "").toLowerCase();
      const ariaBusy = String(element.getAttribute?.("aria-busy") || "").toLowerCase() === "true";
      const label = `${element.getAttribute?.("aria-label") || ""} ${element.getAttribute?.("title") || ""}`.toLowerCase();
      const classes = typeof element.className === "string"
        ? element.className.toLowerCase()
        : String(element.className?.baseVal || "").toLowerCase();
      const customLoader = /(?:^|[-_])(loader|spinner|loading|progress)(?:$|[-_])/.test(element.localName || "");
      const namedLoader = /(?:spinner|loading|loader|carregando|progress)/i.test(`${classes} ${label}`);
      return role === "progressbar" || ariaBusy || customLoader || namedLoader;
    });
  }

  function findPolandList(root) {
    const noDataPhrases = [
      "no records to display", "no records found", "no record found",
      "nenhum registro para exibir", "nenhum registro encontrado", "nenhum chamado encontrado",
      "nao ha chamados", "nao ha registros"
    ];
    const pageText = normalize(readDeepText(root));
    const emptyMessage = noDataPhrases.some((phrase) => pageText.includes(phrase));
    const ids = new Set();
    let rowCount = 0;
    let missingCallerRows = 0;

    // Use the same row and Caller-link selectors as the console script proven on this list.
    const classicRows = [...root.querySelectorAll("tr.list_row")];
    if (classicRows.length) {
      for (const row of classicRows) {
        rowCount += 1;
        const callerLink = row.querySelector('a[data-table="sys_user"]') || row.querySelector('a[href*="sys_user"]');
        if (!callerLink) {
          missingCallerRows += 1;
          continue;
        }
        const href = callerLink.getAttribute("href") || callerLink.href || "";
        let sysId = "";
        try {
          const link = new URL(href, location.href);
          if (link.origin === location.origin) sysId = link.searchParams.get("sys_id") || "";
        } catch {
          // Try the encoded link text below; unreadable IDs remain inconclusive.
        }
        if (!/^[a-f0-9]{32}$/i.test(sysId)) {
          let decodedHref = href;
          try { decodedHref = decodeURIComponent(href); } catch { /* Keep the original link text. */ }
          sysId = decodedHref.match(/[?&]sys_id=([a-f0-9]{32})(?:&|$)/i)?.[1]
            || decodedHref.match(/%3f[^#]*?sys_id%3d([a-f0-9]{32})(?:%26|$)/i)?.[1]
            || "";
        }
        if (/^[a-f0-9]{32}$/i.test(sysId)) ids.add(sysId.toLowerCase());
        else missingCallerRows += 1;
      }
      return {
        found: true,
        loading: hasLoadingIndicator(root),
        rowCount,
        missingCallerRows,
        sysIds: [...ids],
        emptyMessage
      };
    }

    const elements = deepElements(root);
    const rows = elements.filter((element) => element.localName === "tr" || element.getAttribute("role") === "row");
    const listContainer = (row) => {
      let current = row;
      while (current && current !== root) {
        const role = String(current.getAttribute?.("role") || "").toLowerCase();
        if (current.localName === "table" || role === "grid" || role === "table") return current;
        current = parentAcrossShadow(current);
      }
      return null;
    };
    const cellsForRow = (row) => {
      const cells = [];
      const walkCell = (node) => {
        if (!node || node.nodeType !== 1) return;
        const role = String(node.getAttribute("role") || "").toLowerCase();
        if (["th", "td"].includes(node.localName) || ["columnheader", "cell", "gridcell"].includes(role)) {
          cells.push(node);
          return;
        }
        for (const child of composedChildren(node)) walkCell(child);
      };
      for (const child of composedChildren(row)) walkCell(child);
      return cells;
    };
    const rowsByContainer = new Map();
    for (const row of rows) {
      const container = listContainer(row);
      if (!container) continue;
      if (!rowsByContainer.has(container)) rowsByContainer.set(container, []);
      rowsByContainer.get(container).push(row);
    }

    let found = false;
    let loading = false;

    for (const [container, rowsInContainer] of rowsByContainer) {
      const headerRows = rowsInContainer.map((row, rowIndex) => {
        const cells = cellsForRow(row);
        const callerIndex = cells.findIndex((cell) => textOf(cell).includes("caller"));
        return callerIndex >= 0 ? { row, rowIndex, callerIndex } : null;
      }).filter(Boolean);
      if (!headerRows.length) continue;
      found = true;
      if (hasLoadingIndicator(container)) loading = true;

      const header = headerRows[0];
      for (const row of rowsInContainer.slice(header.rowIndex + 1)) {
        const cells = cellsForRow(row);
        if (!cells.some((cell) => ["td", "cell", "gridcell"].includes(cell.localName) || ["cell", "gridcell"].includes(String(cell.getAttribute("role") || "").toLowerCase()))) continue;
        const rowText = textOf(row);
        if (!rowText) continue;
        if (noDataPhrases.some((phrase) => rowText.includes(phrase))) continue;
        rowCount += 1;
        const callerCell = cells[header.callerIndex];
        if (!callerCell) {
          missingCallerRows += 1;
          continue;
        }
        const anchors = [callerCell, ...deepElements(callerCell)].filter((element) => element.localName === "a");
        const callerIds = [];
        for (const anchor of anchors) {
          try {
            const href = anchor.getAttribute("href") || anchor.href || "";
            const link = new URL(href, location.href);
            if (link.origin !== location.origin || !/sys_user\.do/i.test(decodeURIComponent(link.pathname))) continue;
            const decodedHref = decodeURIComponent(href);
            const embeddedSysId = decodedHref.match(/[?&]sys_id=([a-f0-9]{32})(?:&|$)/i)?.[1] || "";
            const sysId = link.searchParams.get("sys_id") || embeddedSysId;
            if (/^[a-f0-9]{32}$/i.test(sysId)) callerIds.push(sysId.toLowerCase());
          } catch {
            // An unreadable caller link is handled as an incomplete row below.
          }
        }
        if (!callerIds.length) missingCallerRows += 1;
        else callerIds.forEach((sysId) => ids.add(sysId));
      }
    }
    return { found, loading, rowCount, missingCallerRows, sysIds: [...ids], emptyMessage };
  }

  function trackDashboardActivity() {
    const key = "__snBacklogMonitorLastInteraction";
    if (!Number.isFinite(globalThis[key])) {
      globalThis[key] = 0;
      let lastSentAt = 0;
      const recordInteraction = () => {
        const at = Date.now();
        globalThis[key] = at;
        if (at - lastSentAt >= 2000) {
          lastSentAt = at;
          try {
            chrome.runtime.sendMessage({ type: "PANEL_INTERACTION", at }).catch(() => {});
          } catch {
            // The page may be closing while the passive activity marker is sent.
          }
        }
      };
      for (const eventName of ["pointerdown", "keydown", "wheel", "touchstart", "input", "change"]) {
        document.addEventListener(eventName, recordInteraction, { capture: true, passive: true });
      }
    }
    return Number(globalThis[key]) || 0;
  }
}

async function emitBacklogAlert(operation, detail) {
  const title = operation === "aptivPoland"
    ? "APTIV - Possível Chamado Backlog APTIV Polônia"
    : operation === "aptiv"
      ? "APTIV - Possível Chamado Backlog APTIV Brasil"
      : "BRASILSEG - Possível Chamado Backlog BrasilSEG";
  const message = operation === "aptivPoland"
    ? detail
    : operation === "aptiv"
      ? detail
      : "Confira as áreas Reação e Resolução no painel.";
  await Promise.allSettled([
    playAlertSound(),
    showNotification(title, message, operation)
  ]);
}

async function showNotification(title, message, suffix) {
  try {
    await chrome.notifications.create(`${suffix}-backlog`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title,
      message,
      priority: 2
    });
  } catch {
    // A policy or operating-system setting may disable desktop notifications.
  }
}

async function playAlertSound() {
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ target: "offscreen", type: "PLAY_ALERT_SOUND" });
  } catch {
    // Notifications remain available if the browser blocks audio playback.
  }
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (contexts.length) return;
  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Reproduzir um alerta sonoro quando um indicador monitorado apresentar backlog."
    }).finally(() => { creatingOffscreenDocument = null; });
  }
  await creatingOffscreenDocument;
}
