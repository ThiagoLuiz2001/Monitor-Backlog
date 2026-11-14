/**
 * alerts.js — Alertas de backlog: som via offscreen document e notificações do Chrome.
 */

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
