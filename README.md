# Discotavo

Sala de voz simples para ~8 amigos, no navegador. Você roda o servidor no seu PC, ele gera um código, e quem tiver o código entra e fala. Uma pessoa por vez pode compartilhar a tela. Sem texto, sem contas.

## Como funciona

- **Áudio:** WebRTC em malha (cada pessoa conecta direto com cada outra). O seu PC não carrega o áudio de ninguém.
- **Sinalização:** o servidor Node (`server.js`) só apresenta os participantes via WebSocket (`/ws`). Estado da sala fica em memória (`room.js`) e some quando o servidor fecha.
- **Acesso externo:** um [Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) dá uma URL HTTPS pública sem abrir portas no roteador. HTTPS é obrigatório para o navegador liberar o microfone.

## Uso

```sh
npm install
npm start
```

O terminal mostra o código e o link, por exemplo:

```
Código da sala: K7QM-2XPD
Link para os amigos: https://algo.trycloudflare.com/#K7QM-2XPD
```

Mande o link (ou a URL + o código). Fechar o servidor encerra a sala.

Para o link público é preciso ter o `cloudflared` no PATH. No Fedora ele não está nos repositórios: baixe o binário `cloudflared-linux-amd64` da [página de releases](https://github.com/cloudflare/cloudflared/releases), renomeie para `cloudflared`, coloque em `~/.local/bin` e dê `chmod +x`. Não precisa de conta. Sem ele o servidor sobe só em `http://localhost:3000`, que serve para testar sozinho (o `localhost` conta como contexto seguro para o microfone).

### Opções

| Variável / flag | Efeito |
|---|---|
| `PORT=4000` | Porta do servidor (padrão 3000) |
| `ROOM_CODE=ABCD-1234` | Fixa o código em vez de gerar um aleatório |
| `--no-tunnel` | Não inicia o `cloudflared` |
| `TURN_URL`, `TURN_USER`, `TURN_CREDENTIAL` | Servidor TURN de reserva (várias URLs separadas por vírgula) |

## Compartilhamento de tela

- Só uma pessoa compartilha por vez; o botão dos outros fica desativado enquanto isso. Sem áudio do sistema.
- O player mostra quem compartilha, o selo AO VIVO, o tempo no ar, a qualidade que está chegando (altura e fps medidos no vídeo recebido) e quantos assistem. Os controles são **Preencher / Ajustar à janela**, **janela flutuante** (Picture-in-Picture), **modo teatro** (esconde a lateral) e **tela cheia**. Somem após 3 s sem movimento e voltam ao mexer o mouse ou usar o teclado. Janela flutuante e tela cheia só aparecem se o navegador suportar.
- No mesh, quem compartilha envia o vídeo uma vez para cada espectador. Por isso o vídeo é limitado a 720p, 15 fps e ~1 Mbps por espectador (`SHARE_*` em `public/app.js`). Com 7 espectadores são cerca de 7 Mbps de upload para quem compartilha.
- No Linux com Wayland/Hyprland, o navegador precisa do `xdg-desktop-portal` com o componente de captura de tela do seu compositor (`xdg-desktop-portal-hyprland`).

## Áudio pessoal

O botão de controles na barra (ícone de sliders) abre o painel **Áudio**. Tudo ali é individual: cada pessoa ajusta o seu, fica salvo no `localStorage` do navegador e ninguém mais é afetado (o servidor não participa).

- **Participantes:** volume de 0 a 200% e mudo "só para mim" para cada pessoa, também na lista lateral: clique numa pessoa para abrir o controle de volume dela, como no Discord. O ajuste é lembrado pelo nome da pessoa, então volta igual na próxima vez que ela entrar. Acima de 100% o som pode distorcer.
- **Qualidade do microfone:** predefinições (Econômico 32 kbps, Padrão 64, Alta 128, Estúdio 256 sem tratamento) ou bitrate livre de 16 a 320 kbps, aplicado ao Opus de cada conexão. No mesh o áudio sai uma vez por pessoa na sala, então o painel mostra o upload total (ex.: 7 × 128 = 896 kbps).
- **Tratamento:** supressão de ruído, cancelamento de eco e ganho automático podem ser ligados ou desligados com a chamada em andamento (alguns navegadores só aplicam na próxima entrada), mais um volume do microfone de 0 a 150% com medidor de nível.
- Não há estéreo: o microfone é enviado em mono.

## Soundboard

O botão de ondas na barra abre o **Soundboard**: ao clicar, o som toca para toda a sala (cada pessoa ouve no próprio alto-falante, sem passar pelo microfone) e aparece o aviso "Fulano tocou X". Cada pessoa ajusta o volume ou silencia os sons só para si (salvo no navegador).

- Os sons ficam em `public/sounds/` e são listados em `public/sounds/sounds.json`. Para adicionar um, coloque o arquivo (mp3, ogg ou wav) na pasta e acrescente `{ "id": "meu-som", "name": "Meu som", "file": "meu-som.mp3", "mine": true }`. Reinicie o servidor: ele só aceita ids dessa lista.
- Os sons sem `file` (aplausos, ding, buzina etc.) são sintetizados no navegador a partir de `seq`: `[frequência Hz, duração s, onda]`.
- Cada pessoa pode tocar no máximo um som a cada 400 ms.

## Quedas de conexão

O áudio e a tela vão direto entre os navegadores; a conexão com o servidor (via tunnel) só carrega a sinalização. Se ela cair, a conversa continua, a tela mostra "Reconectando…" e o cliente tenta de novo (1 s, 2 s, 4 s, até 8 s entre tentativas). O servidor segura a vaga por 30 s (`RESUME_GRACE_MS`); dentro desse prazo a pessoa retoma o mesmo lugar sem entrar de novo. Passado o prazo, ela volta para a tela de entrada. Um batimento a cada 10 s detecta conexões que morreram sem avisar.

O terminal do servidor registra cada queda (`ws fechou: ... código ...`) e as retomadas, e repete os erros do `cloudflared`. `TUNNEL_PROTOCOL=http2` faz o tunnel usar TCP em vez de QUIC.

## Limitações conhecidas

- Sem TURN, quem estiver atrás de CGNAT ou NAT restritivo pode não conseguir conectar. Se acontecer, o app avisa e você configura um TURN gerenciado pelas variáveis acima.
- Quick Tunnels não têm garantia de disponibilidade e a URL muda a cada execução.
- O código é a única proteção: quem tiver o link entra. Após 5 códigos errados na mesma conexão, o servidor a fecha.

## Testes

```sh
npm test
```

Cobrem a lógica da sala (código, limite de 8, entrada/saída, repasse de sinalização). A parte de áudio precisa ser testada à mão com dois navegadores.
# discotavo

## Cliente desktop

Em `desktop/` há um app Electron que traz a interface embutida e só usa o servidor para a sinalização.

```sh
cd desktop
npm install
env -u ELECTRON_RUN_AS_NODE npm start   # o unset só é necessário em terminais do VS Code
npm run dist                            # gera .deb e .rpm (Linux) ou o instalador .exe (Windows)
```

No campo **Servidor**, cole o link da sala que o terminal do servidor imprime (`https://algo.trycloudflare.com/#CODIGO`): o app separa o endereço e o código e lembra o servidor da próxima vez. `Ctrl+Shift+M` silencia/ativa o microfone mesmo com a janela em segundo plano.

### Releases automáticas

A cada push na `main` (exceto mudanças só em `.md`), o workflow [release.yml](.github/workflows/release.yml) compila o app e publica uma release `v0.1.<n>` no GitHub com `.deb`, `.rpm` e o instalador `.exe`. Para gerar localmente o `.rpm`/`.deb` no Fedora é preciso `sudo dnf install libxcrypt-compat`.
