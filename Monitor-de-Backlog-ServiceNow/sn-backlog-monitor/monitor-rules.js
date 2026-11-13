(function attachMonitorRules(root, createRules) {
  const rules = createRules();
  if (typeof module === "object" && module.exports) module.exports = rules;
  if (root) root.MonitorRules = rules;
})(globalThis, function createMonitorRules() {
  const ERROR_STATUSES = new Set([
    "Aba não disponível",
    "Aba salva não aberta",
    "Escolha de aba necessária",
    "Aba suspensa",
    "Erro na página",
    "Falha de leitura",
    "Sessão expirada"
  ]);
  const SUCCESS_KINDS = new Set(["backlog", "empty"]);

  function derivePanelStatus(panel) {
    if (ERROR_STATUSES.has(panel?.status)) return "error";
    if (!panel?.checkedAt) return "idle";
    if (SUCCESS_KINDS.has(panel.kind)) return "success";
    return "inconclusive";
  }

  function deriveOverallStatus(state) {
    if (!state?.running) return "idle";

    const panels = ["aptiv", "aptivPoland", "brasilseg"].map((key) => state.panels?.[key]);
    const checkedPanels = panels.filter((panel) => panel?.checkedAt);
    if (!checkedPanels.length) return "idle";

    if (checkedPanels.some((panel) => derivePanelStatus(panel) === "error")) {
      return "error";
    }
    if (panels.some((panel) => derivePanelStatus(panel) !== "success")) {
      return "inconclusive";
    }
    return "success";
  }

  function classifyPolandResult({
    listFound,
    visibleCallerIds = [],
    visibleRows = 0,
    missingCallerRows = 0,
    listLoading = false,
    emptyMessage = false,
    lookup = null
  }) {
    if (!listFound) {
      return {
        kind: "unknown",
        status: "Lista não reconhecida",
        detail: "Não encontrei com segurança a coluna Caller na lista. Nenhuma conclusão foi feita sobre a origem dos chamados."
      };
    }

    if (!visibleCallerIds.length) {
      if (!listLoading && visibleRows === 0 && emptyMessage) {
        return { kind: "empty", status: "Sem chamados visíveis", detail: "A lista reconhecida não contém chamados visíveis." };
      }
      return {
        kind: "unknown",
        status: listLoading ? "Lista carregando" : "Leitura inconclusiva",
        detail: visibleRows > 0
          ? "Há linhas na lista, mas não foi possível ler os links de Caller em todas elas."
          : "A lista ainda não confirmou se está vazia. A extensão não vai presumir que não há chamados."
      };
    }

    if (lookup?.status === "session-expired" && Number(lookup.matchCount) > 0) {
      return {
        kind: "backlog",
        status: "Chamado do Brasil/Portugal detectado",
        detail: "Há pelo menos um chamado visível cujo usuário pertence ao Brasil ou a Portugal.",
        value: lookup.matchCount
      };
    }
    if (lookup?.status === "session-expired") {
      return { kind: "unknown", status: "Sessão expirada", detail: "A consulta dos perfis pediu autenticação. Entre novamente na própria aba do ServiceNow." };
    }
    if (!lookup || lookup.status !== "ok") {
      return {
        kind: "unknown",
        status: "Consulta de usuários inconclusiva",
        detail: `Não consegui consultar os perfis dos solicitantes${lookup?.error ? `: ${lookup.error}` : "."} Confira a própria aba do ServiceNow.`
      };
    }
    if (lookup.matchCount > 0) {
      return {
        kind: "backlog",
        status: "Chamado do Brasil/Portugal detectado",
        detail: "Há pelo menos um chamado visível cujo usuário pertence ao Brasil ou a Portugal.",
        value: lookup.matchCount
      };
    }
    if (lookup.failedCount > 0 || missingCallerRows > 0 || listLoading) {
      return {
        kind: "unknown",
        status: "Consulta de usuários inconclusiva",
        detail: "Não foi possível confirmar a origem de todos os chamados visíveis. A extensão não os considera de outro país e continuará atualizando a lista para procurar novos chamados."
      };
    }
    return { kind: "empty", status: "Sem chamado do Brasil/Portugal", detail: "Nenhum chamado visível foi associado a um usuário do Brasil ou de Portugal." };
  }

  return Object.freeze({ derivePanelStatus, deriveOverallStatus, classifyPolandResult });
});
