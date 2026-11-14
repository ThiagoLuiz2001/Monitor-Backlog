/**
 * service-worker.js — Orquestrador do Monitor de Backlog ServiceNow (v2.6.0).
 *
 * A lógica foi dividida em módulos em src/ (carregados via importScripts, que
 * compartilham o escopo global dos classic scripts do service worker):
 *   state.js     — estado, ícones, alarmes, sessão e versão de ciclo
 *   mappings.js  — identidade/restauração dos mapeamentos painel → aba
 *   scraping.js  — leitura do DOM, botão BRASILSEG e lookup de usuários
 *   refresh.js   — recarga/clique em segundo plano com janelas de segurança
 *   alerts.js    — som (offscreen) e notificações
 *   domlog.js    — log de mudanças de DOM/fingerprint
 *   cycle.js     — ciclo de verificação, retry e cache da Polônia
 *   messages.js  — protocolo de mensagens com validação de esquema
 */
importScripts(
  "monitor-rules.js",
  "src/state.js",
  "src/mappings.js",
  "src/scraping.js",
  "src/refresh.js",
  "src/alerts.js",
  "src/domlog.js",
  "src/cycle.js",
  "src/messages.js"
);

chrome.runtime.onInstalled.addListener(async () => {
  await loadCycleVersion();
  const state = await readState();
  await writeState(state);
  await ensureAlarm(state);
  await restoreSavedMappings(true);
});

chrome.runtime.onStartup.addListener(async () => {
  await loadCycleVersion();
  const state = await readState();
  await ensureAlarm(state);
  await restoreSavedMappings(true);
  await updateActionIcon(await readState());
});

void (async () => {
  await loadCycleVersion();
  const state = await readState();
  await ensureAlarm(state);
  await restoreSavedMappings(true);
  await updateActionIcon(await readState());
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
