/**
 * messages.js — Protocolo de mensagens popup ↔ service worker, com validação de esquema.
 */

const MESSAGE_SCHEMAS = {
  GET_STATE: {},
  PANEL_INTERACTION: { at: "number" },
  SET_MAPPING: { operation: "string", tabId: "number|null" },
  SET_INTERVAL: { intervalMinutes: "number" },
  START: {},
  STOP: {},
  CHECK_NOW: {},
  TEST_SOUND: {},
  GET_DOM_CHANGE_LOG: {},
  CLEAR_DOM_CHANGE_LOG: {}
};

/**
 * Valida uma mensagem recebida contra o esquema esperado.
 * @param {object} message - Mensagem do runtime.
 * @returns {string|null} Descrição do erro ou null se válida.
 */
function validateMessage(message) {
  if (!message || typeof message.type !== "string") return "Mensagem sem tipo.";
  const schema = MESSAGE_SCHEMAS[message.type];
  if (!schema) return "Ação desconhecida.";
  for (const [field, rule] of Object.entries(schema)) {
    const value = message[field];
    if (rule === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) return `Campo "${field}" deve ser número.`;
    } else if (rule === "string") {
      if (typeof value !== "string") return `Campo "${field}" deve ser texto.`;
    } else if (rule === "number|null") {
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) return `Campo "${field}" deve ser número ou null.`;
    }
  }
  if (message.type === "SET_MAPPING" && !(message.operation in PANEL_INFO)) return "Operação inválida.";
  if (message.type === "SET_INTERVAL" && message.intervalMinutes < MIN_INTERVAL_MINUTES) return "Intervalo abaixo do mínimo.";
  return null;
}

async function handleMessage(message, sender) {
  const validationError = validateMessage(message);
  if (validationError) throw new Error(validationError);
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
    case "START": {
      const wasRunning = state.running;
      state.running = true;
      if (!wasRunning) await bumpCycleVersion();
      await writeState(state);
      await ensureAlarm(state);
      void runCycle();
      return { state: await readState() };
    }
    case "STOP":
      if (state.running) await bumpCycleVersion();
      state.running = false;
      await writeState(state);
      await ensureAlarm(state);
      return { state };
    case "CHECK_NOW":
      // Verificação manual sempre executa um ciclo novo, mesmo com o monitor
      // desativado; invalida um ciclo automático em andamento para não ficar
      // na fila atrás dele.
      await bumpCycleVersion();
      await runCycle(null, true);
      return { state: await readState() };
    case "TEST_SOUND":
      await playAlertSound();
      await showNotification("Teste do alerta", "Se você ouviu o som, a saída de áudio está funcionando.", "test");
      return {};
    case "GET_DOM_CHANGE_LOG":
      return { log: await getDomChangeLog() };
    case "CLEAR_DOM_CHANGE_LOG":
      return { log: await clearDomChangeLog() };
    default:
      throw new Error("Ação desconhecida.");
  }
}
