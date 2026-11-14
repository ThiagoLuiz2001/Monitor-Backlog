const HOST_PATTERNS = [
  "https://aptiv.service-now.com/*",
  "https://brasilseg.service-now.com/*"
];
const OPERATION_LABELS = { aptiv: "APTIV", aptivPoland: "APTIV Polônia", brasilseg: "BRASILSEG" };
const tabCache = { aptiv: [], aptivPoland: [], brasilseg: [] };
let loadingTabList = false;
let lastTabListLoad = 0;
const MIN_INTERVAL_MINUTES = 0.5;
const UI_THEME_KEY = "monitorUiTheme";
let renderingState = false;
let renderQueued = false;

const byId = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  byId("toggle-monitor").addEventListener("click", toggleMonitoring);
  byId("theme-toggle").addEventListener("click", toggleTheme);
  byId("test-sound").addEventListener("click", () => sendAction("TEST_SOUND"));
  byId("save-interval").addEventListener("click", saveInterval);
  byId("refresh-tabs").addEventListener("click", loadTabs);

  for (const operation of Object.keys(OPERATION_LABELS)) {
    byId(`${operation}-tab`).addEventListener("change", (event) => {
      const selected = event.target.value;
      sendMessage({
        type: "SET_MAPPING",
        operation,
        tabId: selected ? Number(selected) : null
      }).then((response) => {
        setFeedback(response.ok ? "" : response.error || "Não foi possível selecionar essa aba.");
        return renderState();
      });
    });
  }

  await initializeTheme();
  await loadTabs();
  await renderState();
  await loadDomChangeLog();
  window.setInterval(renderState, 1500);
});

async function initializeTheme() {
  try {
    const stored = await chrome.storage.local.get(UI_THEME_KEY);
    applyTheme(stored[UI_THEME_KEY] === "dark" ? "dark" : "light");
  } catch {
    applyTheme("light");
  }
}

async function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(nextTheme);
  try {
    await chrome.storage.local.set({ [UI_THEME_KEY]: nextTheme });
    setFeedback(`Modo ${nextTheme === "dark" ? "escuro" : "claro"} salvo.`, "success");
  } catch (error) {
    setFeedback(`Não foi possível salvar o tema: ${error.message || error}`, "error");
  }
}

function applyTheme(theme) {
  const selectedTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = selectedTheme;
  const button = byId("theme-toggle");
  if (!button) return;
  button.textContent = selectedTheme === "dark" ? "☀ Modo claro" : "☾ Modo escuro";
  button.setAttribute("aria-label", selectedTheme === "dark" ? "Ativar modo claro" : "Ativar modo escuro");
  button.setAttribute("aria-pressed", String(selectedTheme === "dark"));
}

async function loadTabs() {
  if (loadingTabList) return;
  loadingTabList = true;
  setFeedback("");
  try {
    const tabs = await chrome.tabs.query({ url: HOST_PATTERNS });
    tabCache.aptiv = tabs.filter((tab) => hostname(tab.url) === "aptiv.service-now.com");
    tabCache.aptivPoland = [...tabCache.aptiv];
    tabCache.brasilseg = tabs.filter((tab) => hostname(tab.url) === "brasilseg.service-now.com");
    const response = await sendMessage({ type: "GET_STATE" });
    if (!response.ok || !response.state) throw new Error(response.error || "Não foi possível ler as configurações salvas.");
    for (const operation of Object.keys(OPERATION_LABELS)) {
      populateSelect(operation, response.state.mapping[operation], response.state.targets?.[operation]);
    }
    lastTabListLoad = Date.now();
  } catch (error) {
    setFeedback(`Não foi possível listar as abas: ${error.message || error}`);
  } finally {
    loadingTabList = false;
  }
}

function hostname(value) {
  try { return new URL(value).hostname; } catch { return ""; }
}

function populateSelect(operation, selectedTabId, savedTarget) {
  const select = byId(`${operation}-tab`);
  select.replaceChildren();
  select.add(new Option("Selecione uma aba aberta…", ""));

  const tabs = [...tabCache[operation]].sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), "pt-BR"));
  for (const tab of tabs) {
    const title = (tab.title || OPERATION_LABELS[operation]).replace(/\s+/g, " ").trim();
    select.add(new Option(`${title} · aba ${tab.id}`, String(tab.id)));
  }

  const storedId = selectedTabId == null ? "" : String(selectedTabId);
  if (storedId && !tabs.some((tab) => String(tab.id) === storedId)) {
    const targetUrl = savedTarget?.host ? `https://${savedTarget.host}${savedTarget.pathname || ""}` : "";
    const helpText = targetUrl ? ` • ${targetUrl}` : "";
    select.add(new Option(`Aba selecionada não está aberta${helpText}`, storedId));
  } else if (!storedId && savedTarget) {
    const label = savedTarget.title || OPERATION_LABELS[operation];
    const host = savedTarget.host || "";
    const pathname = savedTarget.pathname || "";
    const urlHint = host ? ` (${host}${pathname})` : "";
    const savedOption = new Option(`Painel salvo: ${label}${urlHint} (aguardando aba)`, "saved");
    savedOption.disabled = true;
    select.add(savedOption);
  }
  const desired = storedId || (savedTarget ? "saved" : "");
  select.value = desired;
  if (!select.value) select.value = "";
}

async function saveInterval() {
  const input = byId("interval");
  const intervalMinutes = Number(input.value);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 0.5) {
    setFeedback("Informe um intervalo de pelo menos 0,5 minuto (30 segundos).", "error");
    input.focus();
    return;
  }
  const response = await sendMessage({ type: "SET_INTERVAL", intervalMinutes });
  setFeedback(response.ok ? "Intervalo aplicado." : response.error, response.ok ? "success" : "error");
  await renderState();
}

async function toggleMonitoring() {
  const button = byId("toggle-monitor");
  button.disabled = true;
  setFeedback("");
  try {
    const latest = await sendMessage({ type: "GET_STATE" });
    if (!latest.ok || !latest.state) {
      setFeedback(latest.error || "Não foi possível confirmar o estado atual do monitor.", "error");
      return;
    }
    await sendAction(latest.state.running ? "STOP" : "START");
  } finally {
    button.disabled = false;
    await renderState();
  }
}

async function sendAction(type) {
  const response = await sendMessage({ type });
  if (!response.ok) setFeedback(response.error || "Não foi possível concluir a ação.", "error");
  else if (type === "START") setFeedback("Verificação iniciada.", "success");
  else if (type === "STOP") setFeedback("Verificação desativada.", "success");
  else if (type === "TEST_SOUND") setFeedback("Teste enviado. O som e a notificação dependem das configurações do Chrome e do Windows.", "success");
  await renderState();
}

async function sendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function renderState() {
  if (renderingState) {
    renderQueued = true;
    return;
  }
  renderingState = true;
  try {
    const response = await sendMessage({ type: "GET_STATE" });
    if (!response.ok || !response.state) return;
    const state = response.state;

    const runStatus = byId("run-status");
    const toggle = byId("toggle-monitor");
    const running = Boolean(state.running);
    runStatus.textContent = running ? "Ativa" : "Inativa";
    runStatus.classList.toggle("running", running);
    toggle.dataset.running = String(running);
    toggle.textContent = running ? "Desativar verificação" : "Iniciar verificação";
    toggle.className = running ? "state-button state-button-stop" : "state-button state-button-start";
    toggle.setAttribute("aria-pressed", String(running));

    if (document.activeElement !== byId("interval")) {
      byId("interval").value = state.intervalMinutes;
    }

    const overall = MonitorRules.deriveOverallStatus(state);
    byId("health-indicator").dataset.state = overall;
    byId("health-status").textContent = ({
      idle: "Em espera",
      error: "Falha na verificação",
      inconclusive: "Verificação inconclusiva",
      success: "Três verificações concluídas"
    })[overall];

    let mappedTabMissingFromList = false;
    for (const operation of Object.keys(OPERATION_LABELS)) {
      const panel = state.panels[operation];
      const stateElement = byId(`${operation}-state`);
      stateElement.textContent = panel.status;
      stateElement.dataset.state = MonitorRules.derivePanelStatus(panel);
      byId(`${operation}-detail`).textContent = panel.detail || "";
      byId(`${operation}-time`).textContent = panel.checkedAt ? `Última verificação ${formatTime(panel.checkedAt)}` : "Sem verificação";
      byId(`${operation}-freshness`).textContent = panel.freshness || "";
      const select = byId(`${operation}-tab`);
      const wanted = state.mapping[operation] == null
        ? (state.targets?.[operation] ? "saved" : "")
        : String(state.mapping[operation]);
      if (document.activeElement !== select && select.value !== wanted && [...select.options].some((option) => option.value === wanted)) {
        select.value = wanted;
      }
      if (state.mapping[operation] != null && ![...select.options].some((option) => option.value === wanted)) {
        mappedTabMissingFromList = true;
      }
    }
    if (mappedTabMissingFromList && Date.now() - lastTabListLoad >= 5000) await loadTabs();
  } finally {
    renderingState = false;
    if (renderQueued) {
      renderQueued = false;
      void renderState();
    }
  }
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(timestamp));
}

function setFeedback(message, tone = "error") {
  const feedback = byId("feedback");
  feedback.textContent = message || "";
  feedback.dataset.tone = message ? tone : "";
}

async function loadDomChangeLog() {
  try {
    const response = await sendMessage({ type: "GET_DOM_CHANGE_LOG" });
    if (!response.ok || !response.log) return;
    const entries = Object.entries(response.log || {});
    if (!entries.length) return;
    // Show a brief notice if there are recent DOM changes that may indicate a ServiceNow UI update
    const recent = entries.filter(([, v]) => Date.now() - (v?.firstSeen || 0) < 24 * 60 * 60 * 1000).length;
    if (recent) {
      setFeedback(`Nota: foram detectadas ${recent} mudança(s) recente(s) no DOM. Se a extensão parar de funcionar, a interface do ServiceNow pode ter sido atualizada.`, "warning");
    }
  } catch {
    // Ignore if the message type is not supported yet.
  }
}
