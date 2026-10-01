# Host PSM ReLapse • ESP32-S2

Web Installer local do Host PSM ReLapse v1.2.3. Revisão do instalador: 2026-09-12-r1.
Compatibilidade informada pelo projeto: PS5 FW **7.00–13.60**, via ReLapse, com PLDMGR embutido na ESP32-S2.

## Gerar e publicar

Execute `GERAR_HOST_INSTALLER.bat` na raiz do projeto completo. O gerador usa o
Arduino/core/bibliotecas já instalados, recompila, valida e publica pelo fluxo
Git + GitHub CLI no WSL já existente. Não lê nem grava a ESP32-S2.

O ZIP de fontes não contém o firmware compilado. O manifesto com `parts: []`
é proposital: somente o build real produz os quatro `.bin` e seus hashes.
Não publique apenas o JavaScript sobre um manifesto antigo. Gere e publique o
site completo para atualizar juntos página, instalador, manifesto e firmware.

Não há CDN, biblioteca remota de gravação, dump de 4 MiB ou NVS no manifesto.
Os downloads feitos pela página são arquivos relativos do próprio site.

## Instalar

1. Abra o instalador em Chrome/Edge compatível, por HTTPS ou localhost.
2. Desconecte a ESP32-S2, segure BOOT/B0 ao reconectar e solte o botão.
3. Clique em **Selecionar e instalar** e escolha a porta da ESP32-S2.
4. Aguarde a conferência dos arquivos, conexão, gravação, verificação da flash
   e encerramento da conexão.
5. Depois de **Firmware gravado e verificado**, desconecte e reconecte a ESP
   com BOOT liberado para iniciar o firmware.

No PS5: Wi-Fi **HostPSM**, DNS **10.1.1.1**, depois **Guia do Usuário**.

O instalador não envia reset automático na entrada nem na saída. Uma porta
aparecer no seletor não comprova modo de gravação. A família do chip e a
capacidade JEDEC são consultadas antes do primeiro apagamento.

A porcentagem representa dados confirmados. Chegar a 100% de transferência
não conclui o processo: ainda são necessárias a verificação e a liberação da
porta. Se a flash foi verificada e o fechamento falhar, os dois estados aparecem
separadamente; reconecte a placa e recarregue a página antes de tentar novamente.

## Diagnóstico

**Testar conexão** funciona mesmo sem firmware gerado. Apenas abre a porta,
cria os streams e encerra a conexão: não envia comandos, não apaga e não grava.
Não confirma modo BOOT. É destinado a separar a falha de abertura das etapas
posteriores. **Baixar diagnóstico** exporta o registro da tentativa em JSON.
O último registro também é mantido no armazenamento local do navegador, quando
disponível; pode ser recuperado na tela de preparação após recarregar a página.

O botão **Interromper** cancela downloads e impede novos comandos. Se a gravação
já começou, a flash pode ficar incompleta e exige nova instalação completa.
Operações nativas de Web Serial não oferecem cancelamento equivalente ao de
`fetch`: um prazo vencido invalida a sessão e inicia a limpeza possível. Uma
abertura tardia apenas é encerrada, sem gravar. Se a liberação não for confirmada,
o instalador bloqueia outra tentativa nessa página.

## Estado de validação

As regressões de protocolo, transporte, downloads, controladores e gerador foram
executadas com dependências modeladas. O firmware, motor, rede e payload do anexo
foram preservados. **Esta revisão ainda requer validação na ESP32-S2 e no
navegador do usuário**, inclusive no caso sem BOOT. Timeout e orientação BOOT não
comprovam a correção de um congelamento do processo nativo do navegador.
Histórico completo: `auditoria/WEB_INSTALLER_CORRECOES_20260912.md` no projeto.
