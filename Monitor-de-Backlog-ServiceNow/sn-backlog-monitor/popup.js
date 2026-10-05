const HOST_PATTERNS = [
  "https://aptiv.service-now.com/*",
  "https://brasilseg.service-now.com/*"
];
const OPERATION_LABELS = { aptiv: "APTIV", aptivPoland: "APTIV Polônia", brasilseg: "BRASILSEG" };
const tabCache = { aptiv: [], aptivPoland: [], brasilseg: [] };
let loadingTabList = false;
let lastTabListLoad = 0;

const byId = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  byId("start").addEventListener("click", () => sendAction("START"));
  byId("stop").addEventListener("click", () => sendAction("STOP"));
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

  await loadTabs();
  await renderState();
  window.setInterval(renderState, 1500);
});

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
    select.add(new Option("Aba selecionada não está aberta", storedId));
  } else if (!storedId && savedTarget) {
    const label = savedTarget.title || OPERATION_LABELS[operation];
    const savedOption = new Option(`Painel salvo: ${label} (aguardando aba)`, "saved");
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
    setFeedback("Informe um intervalo de pelo menos 0,5 minuto (30 segundos).");
    input.focus();
    return;
  }
  const response = await sendMessage({ type: "SET_INTERVAL", intervalMinutes });
  setFeedback(response.ok ? "Intervalo aplicado." : response.error);
  await renderState();
}

async function sendAction(type) {
  setFeedback("");
  const response = await sendMessage({ type });
  if (!response.ok) setFeedback(response.error || "Não foi possível concluir a ação.");
  else if (type === "START") setFeedback("Monitoramento iniciado; a primeira leitura está sendo feita.");
  else if (type === "STOP") setFeedback("Monitoramento parado.");
  else if (type === "TEST_SOUND") setFeedback("Teste enviado. O som e a notificação dependem das configurações do Chrome e do Windows.");
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
  const response = await sendMessage({ type: "GET_STATE" });
  if (!response.ok || !response.state) return;
  const state = response.state;

  const runStatus = byId("run-status");
  runStatus.textContent = state.running ? "Ativo" : "Parado";
  runStatus.classList.toggle("running", state.running);
  if (document.activeElement !== byId("interval")) {
    byId("interval").value = state.intervalMinutes;
  }

  let mappedTabMissingFromList = false;
  for (const operation of Object.keys(OPERATION_LABELS)) {
    const panel = state.panels[operation];
    byId(`${operation}-state`).textContent = panel.status;
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
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(timestamp));
}

function setFeedback(message) {
  byId("feedback").textContent = message || "";
}
