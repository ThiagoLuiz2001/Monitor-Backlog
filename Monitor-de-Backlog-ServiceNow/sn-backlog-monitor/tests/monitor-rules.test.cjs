const test = require("node:test");
const assert = require("node:assert/strict");
const { deriveOverallStatus, classifyPolandResult } = require("../monitor-rules.js");

function panel(kind, status = "OK") {
  return { checkedAt: 1, kind, status };
}

function state(running, panels) {
  return { running, panels };
}

test("toolbar state is white while stopped or before the first result", () => {
  const untouched = { aptiv: {}, aptivPoland: {}, brasilseg: {} };
  assert.equal(deriveOverallStatus(state(false, untouched)), "idle");
  assert.equal(deriveOverallStatus(state(true, untouched)), "idle");
});

test("individual panel states distinguish success, error, inconclusive, and idle", () => {
  const { derivePanelStatus } = require("../monitor-rules.js");
  assert.equal(derivePanelStatus({ checkedAt: null, kind: "unknown", status: "Aguardando configuração" }), "idle");
  assert.equal(derivePanelStatus(panel("empty")), "success");
  assert.equal(derivePanelStatus(panel("unknown", "Falha de leitura")), "error");
  assert.equal(derivePanelStatus(panel("unknown", "Consulta de usuários inconclusiva")), "inconclusive");
});

test("toolbar state is green only after all three successful results", () => {
  assert.equal(deriveOverallStatus(state(true, {
    aptiv: panel("empty"),
    aptivPoland: panel("backlog"),
    brasilseg: panel("empty")
  })), "success");
});

test("toolbar state is orange for incomplete checks, even if their detail contains the Poland warning", () => {
  const warningOnly = {
    ...panel("empty", "Sem chamado do Brasil/Portugal"),
    detail: "Não foi possível confirmar a origem de todos os chamados visíveis."
  };
  assert.equal(deriveOverallStatus(state(true, {
    aptiv: panel("empty"),
    aptivPoland: warningOnly,
    brasilseg: panel("empty")
  })), "success");
  assert.equal(deriveOverallStatus(state(true, {
    aptiv: panel("empty"),
    aptivPoland: panel("unknown", "Consulta de usuários inconclusiva"),
    brasilseg: panel("empty")
  })), "inconclusive");
});

test("toolbar state prioritizes errors over inconclusive and success results", () => {
  assert.equal(deriveOverallStatus(state(true, {
    aptiv: panel("unknown", "Falha de leitura"),
    aptivPoland: panel("unknown", "Consulta de usuários inconclusiva"),
    brasilseg: panel("empty")
  })), "error");
});

test("a recognized empty Poland list is successful with few or many fully-read callers", () => {
  for (const visibleRows of [2, 120]) {
    const result = classifyPolandResult({
      listFound: true,
      visibleCallerIds: Array.from({ length: visibleRows }, (_, index) => `caller-${index}`),
      visibleRows,
      lookup: { status: "ok", matchCount: 0, failedCount: 0 }
    });
    assert.equal(result.kind, "empty");
  }
});

test("Poland remains inconclusive when an unreadable row, lookup failure, or active list loader is evidenced", () => {
  for (const detail of [
    { missingCallerRows: 1 },
    { lookup: { status: "ok", matchCount: 0, failedCount: 1 } },
    { listLoading: true }
  ]) {
    const result = classifyPolandResult({
      listFound: true,
      visibleCallerIds: ["caller-1"],
      visibleRows: 2,
      lookup: { status: "ok", matchCount: 0, failedCount: 0 },
      ...detail
    });
    assert.equal(result.kind, "unknown");
  }
});

test("a confirmed Poland match is still reported when another profile read is incomplete", () => {
  const result = classifyPolandResult({
    listFound: true,
    visibleCallerIds: ["caller-1", "caller-2"],
    visibleRows: 2,
    listLoading: true,
    lookup: { status: "ok", matchCount: 1, failedCount: 1 }
  });
  assert.equal(result.kind, "backlog");
});
