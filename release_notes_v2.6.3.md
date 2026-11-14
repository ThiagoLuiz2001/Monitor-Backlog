### Release Notes v2.6.3 — 13/11/2026

**Corrigido**

* **Bug crítico**: função `normalize` dentro de `collectPanelFrame` (content script injetado) tinha regex Unicode quebrado — literais `̀-ͯ` e `s+` em vez de `̀-ͯ` e `\s+`.
* Isso fazia `normalize(bodyText)` retornar string vazia → `noReadableContent: true` → erro **"NENHUM CONTEUDO ACESSIVEL FOI ENCONTRADO NO DOMINIO AUTORIZADO"** em **todos os 3 painéis**.
* Corrigido ambos os `.replace()` no `normalize` local do content script.