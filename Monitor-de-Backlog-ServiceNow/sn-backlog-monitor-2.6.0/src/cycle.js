/**
 * cycle.js — Ciclo de verificação dos três painéis, com retry de leitura,
 * cache de consulta de usuários da Polônia e registro do último ciclo.
 */

const POLAND_LOOKUP_CACHE_KEY = "polandCallerCache";
const POLAND_LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;
const POLAND_LOOKUP_MAX_IDS = 20;
const READ_RETRY_DELAYS_MS = [3000, 8000];

/**
 * Executa a leitura dos frames com retry e backoff curto para falhas transitórias.
 * @param {number} tabId - Aba alvo.
 * @param {string} operation - Painel sendo lido.
 * @returns {Promise<Array>} Resultados por frame.
 */
async function readFramesWithRetry(tabId, operation) {
  let lastError = null;
  for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: collectPanelFrame,
        args: [operation]
      });
    } catch (error) {
      lastError = error;
      if (attempt < READ_RETRY_DELAYS_MS.length) await sleep(READ_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

/**
 * Consulta o cache de perfis de usuários da Polônia; retorna os sys_ids que
 * ainda precisam de lookup e os resultados já cacheados (válidos por 5 min).
 */
async function partitionPolandLookupIds(sysIds) {
  const unique = [...new Set(sysIds)];
  const stored = await chrome.storage.local.get(POLAND_LOOKUP_CACHE_KEY);
  const cache = stored[POLAND_LOOKUP_CACHE_KEY] || {};
  const now = Date.now();
  const cached = {};
  const missing = [];
  for (const id of unique) {
    const entry = cache[id];
    if (entry && now - Number(entry.at || 0) < POLAND_LOOKUP_CACHE_TTL_MS) cached[id] = entry;
    else missing.push(id);
  }
  return { cached, missing: missing.slice(0, POLAND_LOOKUP_MAX_IDS), truncated: missing.length > POLAND_LOOKUP_MAX_IDS };
}

/** Persiste no cache os resultados de lookup por sys_id. */
async function savePolandLookupCache(results) {
  if (!results || typeof results !== "object") return;
  const stored = await chrome.storage.local.get(POLAND_LOOKUP_CACHE_KEY);
  const cache = stored[POLAND_LOOKUP_CACHE_KEY] || {};
  const now = Date.now();
  for (const [id, entry] of Object.entries(results)) cache[id] = { ...entry, at: now };
  await chrome.storage.local.set({ [POLAND_LOOKUP_CACHE_KEY]: cache });
}

/** Converte o resultado do lookup em página em formato agregado usado pela regra. */
function aggregatePolandLookup(lookup, cachedResults) {
  const cached = Object.values(cachedResults || {});
  const matchCount = (Number(lookup?.matchCount) || 0) + cached.filter((c) => c.match).length;
  const failedCount = (Number(lookup?.failedCount) || 0) + cached.filter((c) => !c.match && !c.hasDirectoryInfo).length;
  const sessionExpired = lookup?.status === "session-expired" || cached.some((c) => c.sessionExpired);
  if (sessionExpired) return { status: "session-expired", matchCount, failedCount };
  if (!lookup || lookup.status !== "ok") return { status: lookup?.status || "error", error: lookup?.error, matchCount, failedCount };
  return { status: "ok", matchCount, failedCount };
}

async function runCycle(onlyOperation = null) {
  if (currentCycle && currentCycleVersion === cycleVersion) return currentCycle;
  if (currentCycle) {
    try { await currentCycle; } catch { /* The previous cycle has already reported its failure. */ }
  }
  if (currentCycle && currentCycleVersion === cycleVersion) return currentCycle;

  const runVersion = cycleVersion;
  const cycle = performCycle(onlyOperation, runVersion);
  currentCycle = cycle;
  currentCycleVersion = runVersion;
  try {
    await cycle;
  } catch (error) {
    console.error("Falha no ciclo do monitor de backlog:", error);
  } finally {
    if (currentCycle === cycle) currentCycle = null;
  }
}

async function performCycle(onlyOperation = null, runVersion = cycleVersion) {
  await restoreSavedMappings();
  if (runVersion !== cycleVersion) return;
  const state = await readState();
  if (!state.running) return;
  const checkedMapping = { ...state.mapping };
  const operations = onlyOperation && onlyOperation in PANEL_INFO ? [onlyOperation] : Object.keys(PANEL_INFO);

  for (const operation of operations) {
    if (runVersion !== cycleVersion) return;
    await checkOperation(operation, state, runVersion);
  }
  if (runVersion !== cycleVersion) return;
  const latestState = await readState();
  if (runVersion !== cycleVersion) return;
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
  latestState.lastCycleAt = Date.now();
  await writeState(latestState);
}

async function checkOperation(operation, state, runVersion = cycleVersion) {
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
    frames = await readFramesWithRetry(tabId, operation);
  } catch (error) {
    setPanelResult(panel, "unknown", "Falha de leitura", `O Chrome não conseguiu ler esta página: ${shortError(error)}.`);
    return;
  }
  if (runVersion !== cycleVersion) return;

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
    if (runVersion === cycleVersion) {
      if (operation === "brasilseg") {
        await maybeClickBrasilsegRefresh(tab, panel, now, lastInteraction, panel.lastSelectedAt, state.intervalMinutes);
      } else {
        await maybeRefreshAfterIdle(tab, panel, now, false, lastInteraction, panel.lastSelectedAt, true, state.intervalMinutes);
      }
    }
    return;
  }

  if (operation === "aptivPoland") {
    await checkPolandOperation(tab, panel, state, now, readings, lastInteraction, runVersion);
    return;
  }

  const result = operation === "aptiv" ? combineAptiv(readings) : combineBrasilseg(readings);
  if (runVersion !== cycleVersion) return;
  if (!result) {
    setPanelResult(panel, "unknown", "Falha de leitura", "O indicador esperado não foi encontrado no conteúdo acessível da página.");
    if (runVersion === cycleVersion) {
      if (operation === "brasilseg") {
        await maybeClickBrasilsegRefresh(tab, panel, now, lastInteraction, panel.lastSelectedAt, state.intervalMinutes);
      } else {
        panel.freshness = "A recarga automática foi suspensa porque o indicador não pôde ser lido com confiança.";
      }
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
    if (runVersion === cycleVersion) {
      if (operation === "brasilseg") {
        await maybeClickBrasilsegRefresh(tab, panel, now, lastInteraction, panel.lastSelectedAt, state.intervalMinutes);
      } else {
        panel.freshness = "A recarga automática foi suspensa porque a leitura ficou inconclusiva.";
      }
    }
  } else {
    if (!Number.isFinite(panel.lastSelectedAt) && !Number.isFinite(tab.lastAccessed)) {
      panel.lastSelectedAt = now;
    }
    if (runVersion === cycleVersion) {
      if (operation === "brasilseg") {
        await maybeClickBrasilsegRefresh(tab, panel, now, lastInteraction, panel.lastSelectedAt, state.intervalMinutes);
      } else {
        await maybeRefreshAfterIdle(tab, panel, now, contentChanged, lastInteraction, panel.lastSelectedAt);
      }
    }
  }
}

async function checkPolandOperation(tab, panel, state, now, readings, lastInteraction, runVersion = cycleVersion) {
  const lists = readings.map((reading) => reading.polandList).filter(Boolean);
  const visibleCallerIds = [...new Set(lists.flatMap((list) => list.sysIds || []))];
  const listFound = lists.some((list) => list.found);
  const listLoading = lists.some((list) => list.loading);
  const emptyMessage = lists.some((list) => list.emptyMessage);
  const visibleRows = Math.max(0, ...lists.map((list) => Number(list.rowCount) || 0));
  const missingCallerRows = Math.max(0, ...lists.map((list) => Number(list.missingCallerRows) || 0));
  let lookup = null;
  if (listFound && visibleCallerIds.length) {
    const { cached, missing } = await partitionPolandLookupIds(visibleCallerIds);
    try {
      if (missing.length) {
        const frames = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: lookupPolandCallerOrigins,
          args: [missing]
        });
        const raw = frames?.[0]?.result;
        if (raw?.details) await savePolandLookupCache(Object.fromEntries(raw.details.map((d) => [d.sysId, d])));
        lookup = aggregatePolandLookup(raw, cached);
      } else {
        lookup = aggregatePolandLookup({ status: "ok", matchCount: 0, failedCount: 0 }, cached);
      }
    } catch (error) {
      lookup = aggregatePolandLookup({ status: "error", error: shortError(error) }, cached);
    }

    if (runVersion !== cycleVersion) return;
  }
  const result = MonitorRules.classifyPolandResult({
    listFound,
    visibleCallerIds,
    visibleRows,
    missingCallerRows,
    listLoading,
    emptyMessage,
    lookup
  });
  if (runVersion !== cycleVersion) return;

  const selectedState = await readState();
  const activeSessionToken = await getBrowserSessionToken();
  if (selectedState.mapping.aptivPoland !== tab.id || selectedState.mappingSession.aptivPoland !== activeSessionToken) return;

  setPanelResult(panel, result.kind, result.status, result.detail);
  const marker = readings.map((reading) => reading.refreshMarker).filter(Boolean).sort().join(" | ");
  const fingerprint = JSON.stringify({ kind: result.kind, value: result.value ?? null, marker });
  const previousFingerprint = panel.fingerprint;
  const contentChanged = Boolean(previousFingerprint && previousFingerprint !== fingerprint);
  panel.fingerprint = fingerprint;
  void detectDomChanges("aptivPoland", tab.id, readings, previousFingerprint);

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
  if (runVersion !== cycleVersion) return;
  if (!Number.isFinite(panel.lastSelectedAt) && !Number.isFinite(tab.lastAccessed)) panel.lastSelectedAt = now;
  const [latestState, activity] = await Promise.all([readState(), chrome.storage.local.get(ACTIVITY_KEY)]);
  if (runVersion !== cycleVersion) return;
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
