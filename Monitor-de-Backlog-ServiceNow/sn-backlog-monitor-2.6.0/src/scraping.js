/**
 * scraping.js — Leitura do DOM das páginas ServiceNow (injetado via chrome.scripting),
 * botão de atualização do BRASILSEG e consulta de perfis de usuários (Polônia).
 */

async function lookupPolandCallerOrigins(sysIds) {
  if (location.hostname.toLowerCase() !== "aptiv.service-now.com") return { status: "error" };
  const validIds = [...new Set((Array.isArray(sysIds) ? sysIds : []).filter((id) => /^[a-f0-9]{32}$/i.test(String(id))))];
  if (!validIds.length) return { status: "ok", matchCount: 0, failedCount: 0 };

  const directoryMarkers = ["OU=BR", "OU=PT", "OU=BRAZIL", "OU=PORTUGAL"];
  let matchCount = 0;
  let failedCount = 0;
  let sessionExpired = false;
  const details = [];

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
    const batch = await Promise.all(validIds.slice(index, index + 4).map(async (id) => ({ sysId: id, ...(await checkOne(id)) })));
    for (const result of batch) {
      details.push(result);
      if (result.status === "session-expired") sessionExpired = true;
      else if (result.status !== "ok") failedCount += 1;
      else if (result.match) matchCount += 1;
      else if (!result.hasDirectoryInfo) failedCount += 1;
    }
  }
  return sessionExpired
    ? { status: "session-expired", matchCount, failedCount, details }
    : { status: "ok", matchCount, failedCount, details };
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
    // Expanded refresh selector: broader term list to catch dashboard update buttons
    const refreshTerms = ["refresh", "atualizar", "atualizacao", "recarregar", "reload", "update", "atualiza", "recarrega"];
    const hasRefreshTerm = refreshTerms.some((t) => names.includes(t));
    return hasRefreshTerm || /\b(refresh|atualizar|recarregar|atualiza)\b/.test(names);
  });
  const uniqueControls = controls.filter((element, index) => controls.indexOf(element) === index);
  if (!uniqueControls.length) return { status: "not-found" };
  if (uniqueControls.length !== 1) return { status: "ambiguous" };
  const button = uniqueControls[0];
  if (button.disabled || button.getAttribute("aria-disabled") === "true") return { status: "disabled" };
  button.click();
  return { status: "clicked" };
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
    const ids = new Set();
    let rowCount = 0;
    let missingCallerRows = 0;
    let emptyMessage = false;

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
      const tables = [...new Set(classicRows.map((row) => row.closest("table")).filter(Boolean))];
      return {
        found: true,
        // A spinner elsewhere in the dashboard (or another list) is not proof
        // that these already-readable Caller rows are incomplete.
        loading: tables.some((table) => hasLoadingIndicator(table)),
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
      const containerText = normalize(readDeepText(container));
      if (noDataPhrases.some((phrase) => containerText.includes(phrase))) emptyMessage = true;

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
