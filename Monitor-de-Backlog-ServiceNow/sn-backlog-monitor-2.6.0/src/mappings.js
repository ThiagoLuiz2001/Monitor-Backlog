/**
 * mappings.js — Identidade de abas e restauração dos mapeamentos painel → aba.
 */

/**
 * Extrai identidade estável de uma aba (host, path, título normalizado).
 * @param {object} tab - Aba do chrome.tabs.
 * @returns {{host: string, pathname: string, title: string}|null} Identidade ou null se a URL for inválida.
 */
function tabIdentity(tab) {
  try {
    const url = new URL(tab.url || tab.pendingUrl || "");
    return { host: url.hostname, pathname: url.pathname, title: String(tab.title || "").replace(/\s+/g, " ").trim() };
  } catch {
    return null;
  }
}

/** Normaliza título removendo acentos e colapsando espaços. */
function normalizeTitle(title) {
  return String(title || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Verifica se o título corresponde ao painel esperado (títulos conhecidos dos dashboards). */
function isExpectedPanelTitle(operation, title) {
  const normalized = normalizeTitle(title);
  if (operation === "aptiv") return normalized.includes("capgemini aptiv sd dashboard");
  if (operation === "aptivPoland") return normalized.includes("backlog aptiv polonia");
  return normalized.includes("backlog service desk - copia");
}

/**
 * Procura a aba que corresponde ao alvo salvo (host + pathname + título).
 * @returns {{tab: object|null, reason: string}} Aba encontrada e o motivo da decisão.
 */
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

/**
 * Reassocia mapeamentos salvos às abas abertas nesta sessão do navegador.
 * Executada no máx. uma vez a cada 5s (a menos que force=true).
 * @param {boolean} [force=false] Ignora o throttle de 5 segundos.
 * @returns {Promise<object>} Estado após a restauração.
 */
async function restoreSavedMappings(force = false) {
  if (restoringMappings) return restoringMappings;
  if (!force && Date.now() - lastRestoreScanAt < 5000) return readState();
  restoringMappings = performMappingRestore().finally(() => { restoringMappings = null; });
  return restoringMappings;
}

/** Implementação interna da restauração de mapeamentos. */
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
        // A aba pode ter sido fechada; tenta localizar pela identidade salva abaixo.
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
      const panel = state.panels[operation];
      if (panel.status !== status || panel.detail !== detail || panel.kind !== "unknown" || panel.checkedAt !== null) changed = true;
      panel.kind = "unknown";
      panel.checkedAt = null;
      panel.status = status;
      panel.detail = detail;
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
