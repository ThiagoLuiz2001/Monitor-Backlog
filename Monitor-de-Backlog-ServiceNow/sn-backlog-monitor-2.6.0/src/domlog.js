/**
 * domlog.js — Log de mudanças de DOM/marcadores de atualização, para avisar quando
 * a interface do ServiceNow pode ter mudado.
 */

const DETECT_DOM_CHANGES_KEY = "monitorDomChangeLog";

/**
 * Registra marcadores de atualização vistos e mudanças de fingerprint que podem
 * indicar alteração na UI do ServiceNow.
 */
async function detectDomChanges(operation, tabId, readings, previousFingerprint) {
  const state = await readState();
  const panel = state.panels[operation];
  const currentMarker = readings.map((r) => r.refreshMarker).filter(Boolean).join(" | ");
  const currentFingerprint = panel.fingerprint;

  const stored = await chrome.storage.local.get(DETECT_DOM_CHANGES_KEY);
  const log = stored[DETECT_DOM_CHANGES_KEY] || {};
  let changed = false;
  if (currentMarker) {
    const key = `${operation}:marker:${currentMarker}`;
    if (!log[key]) {
      log[key] = { type: "marker", operation, firstSeen: Date.now(), panelFingerprint: currentFingerprint };
      changed = true;
    }
  }
  if (previousFingerprint && currentFingerprint && previousFingerprint !== currentFingerprint) {
    const key = `${operation}:fingerprint-change:${Date.now()}`;
    log[key] = { type: "fingerprint-change", operation, firstSeen: Date.now(), previousFingerprint, currentFingerprint };
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [DETECT_DOM_CHANGES_KEY]: log });
}

/** Retorna o log de mudanças de DOM. */
async function getDomChangeLog() {
  const stored = await chrome.storage.local.get(DETECT_DOM_CHANGES_KEY);
  return stored[DETECT_DOM_CHANGES_KEY] || {};
}

/** Limpa o log de mudanças de DOM. */
async function clearDomChangeLog() {
  await chrome.storage.local.set({ [DETECT_DOM_CHANGES_KEY]: {} });
  return {};
}
