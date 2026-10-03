# Monitor de Backlog ServiceNow

Extensão local para Google Chrome no Windows, feita em Manifest V3. Ela monitora somente uma aba escolhida pelo usuário em cada um destes domínios:

- `aptiv.service-now.com`
- `brasilseg.service-now.com`

No domínio APTIV, há dois seletores independentes: o painel APTIV Brasil e a lista “Backlog APTIV Polônia”.

## Instalação no Chrome

1. Extraia o arquivo ZIP para uma pasta permanente no computador.
2. Abra `chrome://extensions` no Chrome.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação** e selecione a pasta `sn-backlog-monitor` extraída, que contém `manifest.json`.
5. Abra os painéis APTIV, BRASILSEG e a lista “Backlog APTIV Polônia” no Chrome; entre neles normalmente pela própria página, se necessário.
6. Abra o menu de extensões, escolha **Monitor de Backlog ServiceNow** e selecione em cada lista a aba correta. Os títulos ajudam a distinguir outras páginas abertas do mesmo domínio. A seleção fica salva para as próximas sessões do Chrome.
7. Mantenha o intervalo em 1 minuto ou escolha outro intervalo de pelo menos 0,5 minuto; clique em **Aplicar** e depois em **Iniciar**.
8. Use **Testar som** para conferir o áudio e a notificação do Windows/Chrome.

Se uma versão anterior já estiver carregada, substitua os arquivos da pasta pela versão nova e clique no botão de recarregar (↻) do cartão da extensão em `chrome://extensions`.

O Chrome precisa estar aberto para executar as verificações. As notificações e o som também dependem das configurações do Windows, do Chrome e da organização.

Se o Chrome corporativo bloquear **Carregar sem compactação**, o Modo do desenvolvedor ou a própria extensão, solicite à equipe de TI a instalação/aprovação pelo canal da empresa. A extensão não tenta contornar políticas do navegador.

## O que é lido

- **APTIV:** procura o rótulo `Not Assigned - Brazil` no DOM da aba escolhida e identifica o número no mesmo cartão. Só esse indicador é considerado; valor maior que zero gera alerta.
- **APTIV Polônia:** percorre as linhas da lista que estão disponíveis no DOM, pega o `sys_id` do link na coluna `Caller` e consulta a ficha desse usuário em segundo plano, pela sessão já aberta do ServiceNow. Procura `OU=BR`, `OU=BRASIL`, `OU=BRAZIL`, `OU=PT` ou `OU=PORTUGAL` nos valores dos campos da ficha. O campo `Location` do chamado não participa da decisão. Se algum usuário corresponder, gera alerta e a página é recarregada pelo ciclo normal da APTIV.
- **BRASILSEG:** procura as seções `Reação` e `Resolução`. Reconhece o estado vazio pela mensagem de ausência de dados e procura evidência de linhas/registro no DOM, como linhas de tabela, chamados ServiceNow ou pontos/linhas SVG de série do gráfico. Dados em qualquer uma das duas seções geram alerta.
- Na lista da Polônia, sys_ids e valores dos perfis são usados somente durante a verificação; a extensão não os grava. Se o perfil não puder ser consultado, a sessão expirar, a ficha não expuser valores de OU, a coluna `Caller` não for reconhecida ou alguma linha não tiver um link legível, o estado fica inconclusivo em vez de presumir que o chamado é de outro país. As permissões de leitura do próprio ServiceNow continuam valendo.
- A lista da Polônia só pode ser conferida até onde seus chamados estiverem carregados e expostos no DOM da aba. Paginação, listas virtualizadas ou campos de diretório que não apareçam nos inputs da ficha podem limitar a leitura.
- Se as seções esperadas não forem encontradas, o resultado fica **Leitura inconclusiva** ou **Falha de leitura**. Isso não é tratado como painel vazio.
- Se a aba mostrar formulário de login ou indicação de sessão expirada, o popup informa que é preciso entrar novamente na própria aba. A extensão não faz login.
- Abas fechadas, suspensas, páginas carregando, páginas em branco e erros são apresentados como estados próprios.

## Seleções após reiniciar o Chrome

A extensão salva, para cada painel, o domínio, o caminho e o título da aba escolhida. Não salva a query string nem o fragmento da URL. Ao iniciar o Chrome, tenta associar a seleção salva à aba restaurada com a mesma identidade. Se não houver correspondência única — por exemplo, se duas abas idênticas estiverem abertas — o popup pede uma escolha manual para evitar monitorar a aba errada. Se o Chrome não reabrir a aba, a identidade continua salva e a extensão tenta associá-la quando o painel for aberto.

Ao atualizar de uma versão anterior que guardava apenas o número temporário da aba, a extensão tenta recuperar a seleção pelo título conhecido do painel. Se a aba não estiver aberta ou houver mais de uma candidata, pode ser necessário escolhê-la uma última vez; a nova identidade ficará salva para as próximas inicializações. Atualize os arquivos na mesma pasta da extensão e recarregue o cartão em `chrome://extensions`; não remova a extensão para preservar as configurações locais.

As capturas mostram o texto visível, mas não a estrutura interna do DOM. A leitura procura as mensagens dentro de cada seção separadamente e percorre também áreas abertas de Shadow DOM usadas por componentes web. A nova captura da BRASILSEG mostra um indicador girando em “Reação” e o painel ainda sem renderizar as áreas de conteúdo. Quando a marcação expõe um spinner ou estado de atividade, o popup mostra **Dashboard carregando**; se não expõe, mantém **Leitura inconclusiva**. Em ambos os casos isso não é considerado painel vazio e não dispara um alerta de ausência de backlog. Ao selecionar manualmente a aba, o monitor agenda uma verificação adicional após 30 segundos, além do intervalo normal.

Ainda assim, o Chrome não oferece um comando seguro para obrigar um dashboard a renderizar como se a aba tivesse sido aberta manualmente. A extensão não simula ativação, cliques ou rolagem. Se o ServiceNow só concluir os gráficos quando a aba está visível, a leitura continuará inconclusiva até a página renderizar; nesse período a precisão não pode ser garantida. A tentativa de recuperação em segundo plano pode ajudar quando a página está realmente vazia, mas não contorna esse comportamento do ServiceNow. Se o DOM estiver em canvas, frame de outro domínio ou Shadow DOM fechado, os indicadores também podem não ser legíveis.

O código lê o DOM em contexto isolado do Chrome e não ativa abas, move o mouse, troca de janela ou interage com Genesys/outras aplicações. Na BRASILSEG, tenta um clique programático no único botão de atualização identificável do painel; não simula movimento ou clique físico do mouse. Para evitar atualizar enquanto você usa o painel, listeners passivos observam apenas eventos de ponteiro, teclado, rolagem e edição na aba escolhida e registram somente o horário da última interação; não leem nem guardam o texto digitado ou os valores dos campos. A aba lida é apenas a escolhida para aquela operação. Nenhuma senha, cookie ou credencial/token de autenticação é armazenado. A extensão também mantém um identificador aleatório temporário de sessão do Chrome para não confundir IDs de abas depois de reiniciar; esse identificador não autentica no ServiceNow. Configuração e estado mínimo (IDs das abas, identificação do painel, intervalo, estados e horários de interação) ficam em `chrome.storage.local` no perfil do Chrome.

## Atualização dos painéis

O mesmo intervalo controla a verificação e a atualização das três seleções. Em cada ciclo, a extensão primeiro lê as abas escolhidas e depois atualiza somente a aba correspondente: nos painéis APTIV e na lista da Polônia, solicita a recarga normal da página; na BRASILSEG, tenta o botão interno de atualização do dashboard. Se essa ação da BRASILSEG não puder ser identificada com segurança, a página não é recarregada como alternativa.

As atualizações são adiadas se a aba tiver sido selecionada há menos de dois minutos, se houve interação observada nesse período ou se a página ainda estiver carregando. O popup informa o motivo e o monitor tenta novamente em um ciclo posterior. A tentativa da BRASILSEG respeita o intervalo configurado, mesmo que uma verificação extra seja agendada após a seleção da aba. O clique programático não move o mouse nem ativa a aba, mas o ServiceNow ainda pode ignorar um clique sintético; páginas congeladas pelo Chrome também não executam eventos até voltarem a funcionar. Se a leitura ficar inconclusiva, ela continua inconclusiva — não é convertida em “sem backlog”.

Como a primeira leitura acontece antes da atualização daquele ciclo, se a aba estiver com dados desatualizados um chamado novo pode só ser detectado na próxima verificação. A recarga da APTIV ou o botão de atualização da BRASILSEG podem exigir nova autenticação se a sessão tiver expirado.

## Alertas

O primeiro estado positivo toca três toques de sino mais longos e tenta emitir uma notificação identificada como **“APTIV - Possível Chamado Backlog APTIV Brasil”**, **“APTIV - Possível Chamado Backlog APTIV Polônia”** ou **“BRASILSEG - Possível Chamado Backlog BrasilSEG”**. Na lista da Polônia, o alerta significa que foi encontrado ao menos um chamado visível cujo solicitante tem uma OU correspondente ao Brasil ou a Portugal. Verificações subsequentes não repetem o alerta enquanto o backlog continuar. O alerta volta a tocar depois que o painel é lido como vazio e o backlog reaparece. Uma leitura inconclusiva não limpa o estado positivo anterior.

## Permissões solicitadas

- `https://aptiv.service-now.com/*` e `https://brasilseg.service-now.com/*`: listar as abas desses domínios, ler as abas selecionadas e atualizá-las conforme a regra de cada painel. A consulta dos perfis da lista da Polônia é feita no mesmo domínio APTIV.
- `scripting`: ler os elementos DOM das abas escolhidas e executar a consulta de perfil no contexto da página APTIV, incluindo frames autorizados do mesmo domínio.
- `storage`: guardar seleção das abas, intervalo e estados do monitor no perfil local do Chrome.
- `alarms`: agendar verificações mesmo quando o popup estiver fechado.
- `notifications`: mostrar notificações de backlog.
- `offscreen`: reproduzir som a partir de um documento de áudio oculto, sem abrir ou ativar uma aba.

A extensão não pede permissão `tabs`, acesso a todos os sites, acesso à API de cookies, identidade ou acesso a abas fora dos dois domínios. A consulta de perfil usa a sessão normal da própria página; não copia nem armazena cookies, tokens de autenticação ou senhas.

## Limites do Chrome

O intervalo padrão é 1 minuto. A documentação do Chrome define o mínimo de alarmes periódicos como 30 segundos; alarmes podem disparar com atraso. A extensão exige Chrome 120 ou posterior para usar esse mínimo de forma consistente.

Documentação oficial consultada:

- [Alarmes](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Ciclo de vida de service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Declarar permissões](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Requisições de rede](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Notificações](https://developer.chrome.com/docs/extensions/reference/api/notifications)
