const STORE_KEY = "monitorState";
const ACTIVITY_KEY = "panelInteractionTimes";
const ALARM_NAME = "service-now-backlog-check";
const MIN_INTERVAL_MINUTES = 0.5;
const RECENT_USE_MS = 2 * 60 * 1000;

const PANEL_INFO = {
  aptiv: { label: "APTIV", host: "aptiv.service-now.com" },
  brasilseg: { label: "BRASILSEG", host: "brasilseg.service-now.com" }
};

let creatingOffscreenDocument;
let currentCycle;

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
    mapping: { aptiv: null, brasilseg: null },
    panels: { aptiv: makePanelState(), brasilseg: makePanelState() }
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
    panels: {
      aptiv: { ...base.panels.aptiv, ...((value.panels || {}).aptiv || {}) },
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
    return;
  }
  const interval = Math.max(MIN_INTERVAL_MINUTES, Number(state.intervalMinutes) || 1);
  const alarm = await chrome.alarms.get(ALARM_NAME);
  if (!alarm || alarm.periodInMinutes !== interval) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await readState();
  await writeState(state);
  await ensureAlarm(state);
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await readState();
  await ensureAlarm(state);
});

void (async () => {
  const state = await readState();
  await ensureAlarm(state);
})();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runCycle();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const state = await readState();
  let changed = false;
  for (const operation of Object.keys(PANEL_INFO)) {
    if (state.mapping[operation] === tabId) {
      state.panels[operation].lastSelectedAt = Date.now();
      changed = true;
    }
  }
  if (changed) await writeState(state);
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
      return { state };
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
      if (state.mapping[operation] !== tabId) {
        state.panels[operation] = makePanelState();
        chrome.notifications.clear(`${operation}-backlog`).catch(() => {});
        const stored = await chrome.storage.local.get(ACTIVITY_KEY);
        const times = stored[ACTIVITY_KEY] || {};
        delete times[operation];
        await chrome.storage.local.set({ [ACTIVITY_KEY]: times });
      }
      state.mapping[operation] = tabId;
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

async function runCycle() {
  if (currentCycle) return currentCycle;
  currentCycle = performCycle();
  try {
    await currentCycle;
  } finally {
    currentCycle = null;
  }
}

async function performCycle() {
  const state = await readState();
  if (!state.running) return;
  const checkedMapping = { ...state.mapping };

  for (const operation of ["aptiv", "brasilseg"]) {
    await checkOperation(operation, state);
  }
  const latestState = await readState();
  for (const operation of ["aptiv", "brasilseg"]) {
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
  if (readings.every((reading) => reading.noReadableContent)) {
    setPanelResult(panel, "unknown", "Página sem conteúdo legível", "A aba está em branco ou não expôs texto. O monitor tentará uma recuperação em segundo plano após o período seguro; se persistir, confira a própria aba do ServiceNow.");
    if (!Number.isFinite(panel.lastSelectedAt) && !Number.isFinite(tab.lastAccessed)) panel.lastSelectedAt = now;
    await maybeRefreshAfterIdle(tab, panel, now, false, lastPersistedInteraction, panel.lastSelectedAt, true, state.intervalMinutes);
    return;
  }

  const result = operation === "aptiv" ? combineAptiv(readings) : combineBrasilseg(readings);
  if (!result) {
    setPanelResult(panel, "unknown", "Falha de leitura", "O indicador esperado não foi encontrado no conteúdo acessível da página.");
    panel.freshness = "A recarga automática foi suspensa porque o indicador não pôde ser lido com confiança.";
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
    panel.freshness = "A recarga automática foi suspensa porque a leitura ficou inconclusiva.";
  } else {
    const lastInteraction = Math.max(lastPersistedInteraction, 0, ...readings.map((reading) => Number(reading.lastInteraction) || 0));
    if (!Number.isFinite(panel.lastSelectedAt) && !Number.isFinite(tab.lastAccessed)) {
      panel.lastSelectedAt = now;
    }
    await maybeRefreshAfterIdle(tab, panel, now, contentChanged, lastInteraction, panel.lastSelectedAt);
  }
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
    if (kinds.includes("empty")) return { name, kind: "empty" };
    return { name, kind: "unknown" };
  });
  const positive = sections.filter((section) => section.kind === "backlog").map((section) => section.name);
  if (positive.length) {
    return { kind: "backlog", status: "Backlog detectado", detail: `${positive.join(" e ")} exibe dados`, sections };
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

function collectPanelFrame(operation) {
  const expectedHost = operation === "aptiv" ? "aptiv.service-now.com" : "brasilseg.service-now.com";
  const host = location.hostname.toLowerCase();
  const allowedHost = host === expectedHost;
  if (!allowedHost) return { allowedHost: false };

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
        if (/\b(?:inc|req|ritm|sctask|task)\s*\d{5,}\b/i.test(sectionText)) {
          return { name, kind: "backlog" };
        }
        if (hasDataRows(container, sectionText)) return { name, kind: "backlog" };
        const containerText = textOf(container);
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
  const label = PANEL_INFO[operation].label;
  await Promise.allSettled([
    playAlertSound(),
    showNotification(`Backlog ${label}`, detail, operation)
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
