# Monitor de backlog para ServiceNow — v2.6.0

Evolução da v2.5.0 (que permanece intacta na pasta `sn-backlog-monitor/`). Mesma instalação e mesmos painéis: APTIV, APTIV Polônia e BRASILSEG.

## O que mudou na 2.6.0

- **Service worker modularizado**: a lógica saiu de um único `service-worker.js` (~1.500 linhas) para módulos em `src/` carregados via `importScripts`:
  - `state.js` — estado, ícones da toolbar, alarmes, token de sessão e **versão de ciclo persistida** em `chrome.storage.session` (sobrevive ao encerramento do worker pelo Chrome)
  - `mappings.js` — identidade e restauração dos mapeamentos painel → aba
  - `scraping.js` — leitura do DOM, botão de atualização do BRASILSEG e lookup de usuários da Polônia (agora com **detalhes por sys_id**)
  - `refresh.js` — recarga/clique em segundo plano com janelas de segurança
  - `alerts.js` — som via offscreen document e notificações
  - `domlog.js` — log de mudanças de DOM/fingerprint (agora registra também **mudanças de fingerprint**)
  - `cycle.js` — ciclo de verificação, **retry com backoff** (3s, 8s) em falhas de leitura e **cache de 5 min + limite de 20 sys_ids** no lookup da Polônia
  - `messages.js` — protocolo de mensagens com **validação de esquema**
- **Novo botão "Verificar agora"** no popup (usa a ação `CHECK_NOW` que já existia no backend)
- **Contador "Próxima verificação em ~N s"** no popup (usa o novo campo `lastCycleAt`)
- **Botão "Limpar log de mudanças"** no rodapé do popup (ação `CLEAR_DOM_CHANGE_LOG`)
- **Documentação JSDoc** nos módulos principais
- Testes atualizados e ampliados (19 testes passando: `node --test tests/*.test.cjs`)

## Instalação

Igual à 2.5.0: extraia o ZIP, abra `chrome://extensions`, ative o Modo do desenvolvedor, clique em **Carregar sem compactação** e selecione a pasta `sn-backlog-monitor-2.6.0`.

## Compatibilidade

- Manifest V3, Chrome 120+ (inalterado)
- Permissões e host_permissions idênticos à 2.5.0
- Estado salvo em `chrome.storage.local` é compatível (novos campos recebem valores padrão)
