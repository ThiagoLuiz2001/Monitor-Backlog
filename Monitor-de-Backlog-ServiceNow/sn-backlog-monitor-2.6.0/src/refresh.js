/**
 * refresh.js — Recarga em segundo plano das abas APTIV/Polônia e clique no botão
 * interno do painel BRASILSEG, respeitando janelas de uso recente.
 */

async function maybeRefreshAfterIdle(tab, panel, now, contentChanged, lastInteraction, lastSelectedAt, recovery = false, intervalMinutes = 1) {
  if (tab.status === "loading") {
    panel.freshness = "Recarga adiada: a página ainda está carregando.";
    return;
  }
  const selectedAt = Math.max(Number(lastSelectedAt) || 0, Number(tab.lastAccessed) || 0);
  const activityAt = Number(lastInteraction) || 0;
  const recentlySelected = selectedAt > 0 && now - selectedAt < RECENT_USE_MS;
  const recentlyInteracted = activityAt > 0 && now - activityAt < RECENT_USE_MS;
  if (recentlySelected || recentlyInteracted) {
    const reason = recentlyInteracted
      ? "houve interação com o painel nos últimos dois minutos"
      : "a aba foi selecionada há menos de dois minutos";
    panel.freshness = `Recarga adiada porque ${reason}; nova tentativa no próximo ciclo. A aba pode continuar aberta: sem interação recente, ela poderá ser atualizada em segundo plano.${contentChanged ? " O conteúdo visível mudou desde a última verificação." : ""}`;
    return;
  }
  const recoveryCooldownMs = Math.max(5 * 60 * 1000, (Number(intervalMinutes) || 1) * 60 * 1000);
  if (recovery && Number(panel.lastRefreshAt) > 0 && now - Number(panel.lastRefreshAt) < recoveryCooldownMs) {
    const waitMinutes = Math.max(1, Math.ceil((recoveryCooldownMs - (now - Number(panel.lastRefreshAt))) / 60000));
    panel.freshness = `A página segue sem conteúdo legível. A próxima tentativa de recuperação será em cerca de ${waitMinutes} min.`;
    return;
  }
  try {
    await chrome.tabs.reload(tab.id);
    panel.lastRefreshAt = now;
    panel.freshness = recovery
      ? "A página estava sem conteúdo; tentei recarregá-la em segundo plano. O estado continua inconclusivo até surgir conteúdo legível."
      : `Recarga em segundo plano solicitada após a leitura; a próxima verificação lerá a página atualizada.${contentChanged ? " O conteúdo visível mudou desde a última verificação." : ""}`;
  } catch (error) {
    if (recovery) panel.lastRefreshAt = now;
    panel.freshness = `Não foi possível recarregar a aba em segundo plano: ${shortError(error)}.`;
  }
}

async function maybeClickBrasilsegRefresh(tab, panel, now, lastInteraction, lastSelectedAt, intervalMinutes = 1) {
  if (tab.status === "loading") {
    panel.freshness = "Clique no botão do ServiceNow adiado: a página ainda está carregando.";
    return;
  }
  const selectedAt = Math.max(Number(lastSelectedAt) || 0, Number(tab.lastAccessed) || 0);
  const activityAt = Number(lastInteraction) || 0;
  const recentlySelected = selectedAt > 0 && now - selectedAt < RECENT_USE_MS;
  const recentlyInteracted = activityAt > 0 && now - activityAt < RECENT_USE_MS;
  if (recentlySelected || recentlyInteracted) {
    const reason = recentlyInteracted
      ? "houve interação com o painel nos últimos dois minutos"
      : "a aba foi selecionada há menos de dois minutos";
    panel.freshness = `Clique no botão do ServiceNow adiado porque ${reason}; nova tentativa no próximo ciclo.`;
    return;
  }

  const minClickIntervalMs = Math.max(MIN_INTERVAL_MINUTES * 60 * 1000, (Number(intervalMinutes) || 1) * 60 * 1000);
  const elapsedSinceRefresh = now - (Number(panel.lastRefreshAt) || 0);
  if (panel.lastRefreshAt && elapsedSinceRefresh < minClickIntervalMs) {
    const waitSeconds = Math.max(1, Math.ceil((minClickIntervalMs - elapsedSinceRefresh) / 1000));
    panel.freshness = `O botão já foi acionado neste intervalo; a próxima tentativa será em cerca de ${waitSeconds} s.`;
    return;
  }

  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: clickBrasilsegRefreshButton
    });
    const result = frames?.[0]?.result;
    if (result?.status === "clicked") {
      panel.lastRefreshAt = now;
      panel.freshness = "Botão de atualização do painel acionado em segundo plano; a próxima verificação lerá os dados atualizados.";
    } else if (result?.status === "ambiguous") {
      panel.freshness = "Encontrei mais de um botão de atualização possível no painel; não cliquei para evitar uma ação errada.";
    } else if (result?.status === "not-found") {
      panel.freshness = "Não encontrei o botão de atualização; tentarei recarregar a página em segundo plano como alternativa.";
      try {
        await chrome.tabs.reload(tab.id);
        panel.lastRefreshAt = now;
        panel.freshness = "Botão não encontrado; recarga alternativa executada. A próxima verificação lerá a página atualizada.";
      } catch (e) {
        panel.freshness = "Botão não encontrado; recarga alternativa falhou. Verifique o painel manualmente.";
      }
    } else if (result?.status === "disabled") {
      panel.freshness = "O botão de atualização do ServiceNow está desabilitado; tentarei novamente no próximo ciclo.";
    } else if (result?.status === "not-dashboard") {
      panel.freshness = "Não confirmei as seções Reação e Resolução nesta aba; nenhum botão foi acionado.";
    } else if (result?.status === "loading") {
      panel.freshness = "O documento ainda está carregando; tentarei o botão do ServiceNow no próximo ciclo.";
    } else {
      panel.freshness = "Não foi possível confirmar o botão de atualização do ServiceNow; a página não foi recarregada.";
    }
  } catch (error) {
    panel.freshness = `Não consegui acionar o botão do ServiceNow em segundo plano: ${shortError(error)}. A página não foi recarregada.`;
  }
}
