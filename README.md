# Monitor de backlog para ServiceNow

Extensão local para Google Chrome no Windows, desenvolvida com Manifest V3. Ela acompanha páginas de painel compatíveis, escolhidas pelo usuário, e avisa quando encontra os indicadores de backlog definidos pela extensão.

## Instalação

1. Extraia o arquivo ZIP para uma pasta permanente no computador.
2. No Chrome, abra `chrome://extensions`.
3. Ative o **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação** e selecione a pasta extraída que contém `manifest.json`.
5. Abra e autentique-se nas páginas de painel que deseja acompanhar.
6. Abra o menu de extensões, selecione **Monitor de backlog para ServiceNow** e escolha a aba correta em cada lista. Os títulos ajudam a diferenciar páginas abertas no mesmo domínio.
7. Defina o intervalo de verificação — 1 minuto por padrão, com mínimo de 30 segundos — e clique em **Aplicar** e **Iniciar**.
8. Use **Testar som** para conferir o áudio e as notificações do Chrome/Windows.

Para atualizar uma instalação existente, substitua os arquivos da pasta pela nova versão e clique em recarregar (↻) no cartão da extensão em `chrome://extensions`.

O Chrome precisa permanecer aberto para executar as verificações. Notificações e som dependem também das configurações do navegador, do Windows e das políticas aplicadas ao dispositivo.

Se uma política do navegador impedir o carregamento ou o uso da extensão, consulte o administrador responsável. A extensão não tenta contornar políticas do Chrome.

## Como funciona a leitura

- A extensão verifica apenas as abas selecionadas pelo usuário e procura, na estrutura da página, os indicadores de backlog previstos para cada painel compatível.
- Um indicador positivo gera um alerta. Quando a leitura encontra o estado vazio esperado, o monitor registra que não há backlog naquele momento.
- Se a estrutura esperada não estiver disponível, o resultado é exibido como **Leitura inconclusiva** ou **Falha de leitura**. Uma leitura inconclusiva não é interpretada como painel vazio.
- Se a página apresentar uma tela de login ou uma sessão expirada, o popup informa que é necessário autenticar-se diretamente na página. A extensão não realiza login.
- Abas fechadas, suspensas, ainda carregando, em branco ou com erro são apresentadas em estados próprios.

A extensão lê o DOM — a estrutura da página — e percorre áreas abertas de Shadow DOM usadas por componentes web. Certos gráficos em canvas, frames de outra origem ou áreas fechadas podem não expor dados legíveis; nesses casos, o monitor informa que não conseguiu confirmar o resultado, em vez de assumir que não há backlog.

Em algumas situações, outra extensão ou o próprio navegador pode deixar a página em branco durante uma atualização em segundo plano. O monitor mantém o estado de problema e pode tentar uma recarga de recuperação, respeitando o intervalo seguro descrito abaixo. Se a página continuar em branco, o popup mantém essa limitação visível.

## Privacidade e interação com a página

A leitura ocorre em contexto isolado do Chrome. A extensão não ativa abas, clica, move o mouse, troca de janela nem interage com outros aplicativos.

Para evitar uma recarga enquanto a página está em uso, listeners passivos observam eventos de ponteiro, teclado, rolagem e edição somente na aba selecionada. Eles registram apenas o horário da última interação; não leem nem armazenam o texto digitado ou os valores dos campos.

A extensão não armazena conteúdo da página, senhas, cookies ou tokens. A configuração e o estado mínimo do monitor — como IDs das abas selecionadas, intervalo, status e horários de interação — ficam em `chrome.storage.local`, no perfil local do Chrome.

## Atualização dos painéis

Em cada ciclo com leitura confiável — com backlog ou sem backlog — a extensão lê o conteúdo visível e depois solicita uma recarga normal somente na aba selecionada, para buscar dados recentes na próxima verificação.

Se a página estiver em branco, pode haver uma tentativa de recuperação em segundo plano após o período seguro. Ela é limitada a uma vez a cada cinco minutos ou ao intervalo configurado, valendo o maior período. A recarga é adiada se a aba tiver sido selecionada há menos de dois minutos, se houver interação observada nesse período ou se a página ainda estiver carregando. O popup informa o motivo, e o monitor tenta novamente no próximo ciclo.

A aba pode continuar aberta e selecionada. Após dois minutos sem interação observada, a recarga pode ocorrer em segundo plano sem ativar outra aba. O monitor informa se o conteúdo visível mudou desde a leitura anterior; essa mudança pode ter sido causada pela própria recarga.

A primeira leitura ocorre imediatamente ao iniciar o monitoramento e antes da primeira recarga. Se os dados estiverem desatualizados, um item novo pode ser detectado apenas no ciclo seguinte. Uma recarga também pode exigir nova autenticação caso a sessão tenha expirado.

## Alertas

Quando o monitor detecta backlog pela primeira vez, tenta tocar três toques de sino mais longos e emitir uma notificação do Chrome com o nome do painel. Não repete o alerta enquanto o backlog continuar. O alerta volta a ocorrer depois que uma leitura confiável indicar ausência de backlog e uma leitura posterior voltar a detectar itens.

Uma leitura inconclusiva não apaga um estado positivo registrado anteriormente.

## Permissões

A extensão solicita apenas as permissões necessárias às funções descritas:

- **Acesso às páginas compatíveis:** listar as abas correspondentes, ler a aba selecionada e recarregá-la quando as condições acima forem atendidas.
- **`scripting`:** ler os elementos da página selecionada, incluindo frames autorizados da mesma origem.
- **`storage`:** guardar localmente as seleções, o intervalo e o estado do monitor.
- **`alarms`:** agendar verificações mesmo quando o popup estiver fechado.
- **`notifications`:** exibir notificações de backlog.
- **`offscreen`:** reproduzir som sem abrir ou ativar uma aba.

A extensão não solicita acesso a todos os sites, cookies, identidade ou a abas fora dos domínios declarados em sua configuração.

## Compatibilidade com o Chrome

O intervalo padrão é de 1 minuto. Alarmes periódicos no Chrome têm intervalo mínimo de 30 segundos e podem disparar com atraso. Para usar esse mínimo de forma consistente, a extensão exige Chrome 120 ou posterior.

## Referências

- [Alarmes](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Ciclo de vida de service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Declarar permissões](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Notificações](https://developer.chrome.com/docs/extensions/reference/api/notifications)
