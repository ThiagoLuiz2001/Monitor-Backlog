# Monitor de Backlog ServiceNow

Extensão local para Google Chrome no Windows, feita em Manifest V3. Ela monitora somente uma aba escolhida pelo usuário em cada um destes domínios:

- `aptiv.service-now.com`
- `brasilseg.service-now.com`

## Instalação no Chrome

1. Extraia o arquivo ZIP para uma pasta permanente no computador.
2. Abra `chrome://extensions` no Chrome.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação** e selecione a pasta `sn-backlog-monitor` extraída, que contém `manifest.json`.
5. Abra os painéis APTIV e BRASILSEG no Chrome e entre neles normalmente pela própria página, se necessário.
6. Abra o menu de extensões, escolha **Monitor de Backlog ServiceNow** e selecione em cada lista a aba correta. Os títulos ajudam a distinguir outras páginas abertas do mesmo domínio.
7. Mantenha o intervalo em 1 minuto ou escolha outro intervalo de pelo menos 0,5 minuto; clique em **Aplicar** e depois em **Iniciar**.
8. Use **Testar som** para conferir o áudio e a notificação do Windows/Chrome.

Se uma versão anterior já estiver carregada, substitua os arquivos da pasta pela versão nova e clique no botão de recarregar (↻) do cartão da extensão em `chrome://extensions`.

O Chrome precisa estar aberto para executar as verificações. As notificações e o som também dependem das configurações do Windows, do Chrome e da organização.

Se o Chrome corporativo bloquear **Carregar sem compactação**, o Modo do desenvolvedor ou a própria extensão, solicite à equipe de TI a instalação/aprovação pelo canal da empresa. A extensão não tenta contornar políticas do navegador.

## O que é lido

- **APTIV:** procura o rótulo `Not Assigned - Brazil` no DOM da aba escolhida e identifica o número no mesmo cartão. Só esse indicador é considerado; valor maior que zero gera alerta.
- **BRASILSEG:** procura as seções `Reação` e `Resolução`. Reconhece o estado vazio pela mensagem de ausência de dados e procura evidência de linhas/registro no DOM, como linhas de tabela, chamados ServiceNow ou pontos/linhas SVG de série do gráfico. Dados em qualquer uma das duas seções geram alerta.
- Se as seções esperadas não forem encontradas, o resultado fica **Leitura inconclusiva** ou **Falha de leitura**. Isso não é tratado como painel vazio.
- Se a aba mostrar formulário de login ou indicação de sessão expirada, o popup informa que é preciso entrar novamente na própria aba. A extensão não faz login.
- Abas fechadas, suspensas, páginas carregando, páginas em branco e erros são apresentados como estados próprios.

As capturas mostram o texto visível, mas não a estrutura interna do DOM. A leitura agora procura as mensagens dentro de cada seção separadamente e percorre também áreas abertas de Shadow DOM usadas por componentes web. Ainda assim, sem uma sessão autenticada não é possível confirmar a marcação exata desses painéis. Se o ServiceNow desenhar um gráfico em canvas, usar um frame de outro domínio ou encapsular o conteúdo em uma área fechada que o Chrome não disponibilize, a extensão informa leitura inconclusiva em vez de assumir que não há backlog. Se outra extensão deixar a página em branco ao atualizá-la em segundo plano, o monitor mantém o status de problema e tenta uma recarga de recuperação após o período seguro, sem ativar a aba. Se a página continuar em branco depois da tentativa, não há forma confiável de fazê-la renderizar em segundo plano sem interferir na aba; o popup mantém essa limitação visível.

O código lê o DOM em contexto isolado do Chrome e não ativa abas, clica, move o mouse, troca de janela ou interage com Genesys/outras aplicações. Para evitar recarregar enquanto você usa o painel, listeners passivos observam apenas eventos de ponteiro, teclado, rolagem e edição na aba escolhida e registram somente o horário da última interação; não leem nem guardam o texto digitado ou os valores dos campos. A aba lida é apenas a escolhida para aquela operação. Nenhum conteúdo, senha, cookie ou token é armazenado. Configuração e estado mínimo (IDs das abas, intervalo, estados e horários de interação) ficam em `chrome.storage.local` no perfil do Chrome.

## Atualização dos painéis

A cada ciclo com leitura confiável (backlog ou vazio), a extensão primeiro lê o conteúdo visível e então solicita uma recarga normal **somente na aba escolhida**, para que a próxima verificação receba dados recentes do ServiceNow. Se a página estiver em branco, há uma tentativa de recuperação em segundo plano após o período seguro, limitada a uma vez a cada cinco minutos ou ao intervalo configurado, o que for maior. A recarga é adiada se a aba tiver sido selecionada há menos de dois minutos, se houve interação observada nesse período ou se a página ainda estiver carregando; o popup informa o motivo e o monitor tenta novamente no próximo ciclo. A aba pode continuar aberta e selecionada: após dois minutos sem interação observada, a recarga pode ocorrer em segundo plano sem ativar outra aba. A extensão informa se o conteúdo visível mudou desde a leitura anterior, mas isso não prova que o painel atualize sozinho: a própria recarga pode trazer a mudança.

Como a primeira leitura acontece imediatamente ao iniciar o monitoramento e antes da primeira recarga, se a aba estiver com dados desatualizados um chamado novo pode só ser detectado no ciclo seguinte. Depois disso, cada ciclo confiável atualiza a aba escolhida ao final da leitura anterior. A recarga pode exigir nova autenticação se a sessão tiver expirado.

## Alertas

O primeiro estado positivo toca três toques de sino mais longos e tenta emitir uma notificação com o nome da operação. Verificações subsequentes não repetem o alerta enquanto o backlog continuar. O alerta volta a tocar depois que o painel é lido como vazio e o backlog reaparece. Uma leitura inconclusiva não limpa o estado positivo anterior.

## Permissões solicitadas

- `https://aptiv.service-now.com/*` e `https://brasilseg.service-now.com/*`: listar abas desses domínios, ler a aba selecionada e recarregá-la quando a condição descrita acima for atendida.
- `scripting`: ler os elementos DOM da aba escolhida, incluindo frames autorizados do mesmo domínio.
- `storage`: guardar seleção das abas, intervalo e estados do monitor no perfil local do Chrome.
- `alarms`: agendar verificações mesmo quando o popup estiver fechado.
- `notifications`: mostrar notificações de backlog.
- `offscreen`: reproduzir som a partir de um documento de áudio oculto, sem abrir ou ativar uma aba.

A extensão não pede permissão `tabs`, acesso a todos os sites, cookies, identidade ou acesso a abas fora dos dois domínios.

## Limites do Chrome

O intervalo padrão é 1 minuto. A documentação do Chrome define o mínimo de alarmes periódicos como 30 segundos; alarmes podem disparar com atraso. A extensão exige Chrome 120 ou posterior para usar esse mínimo de forma consistente.

Documentação oficial consultada:

- [Alarmes](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Ciclo de vida de service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Declarar permissões](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Notificações](https://developer.chrome.com/docs/extensions/reference/api/notifications)
