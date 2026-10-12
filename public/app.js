'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  const ICON_MIC =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>';
  const ICON_MIC_OFF =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 0 0 5 2.1"/><path d="M15 9.3V6a3 3 0 0 0-5.9-.8"/><path d="M5 11a7 7 0 0 0 11.2 5.6"/><path d="M19 11a7 7 0 0 1-.6 2.8"/><path d="M12 18v3"/></svg>';

  const COLORS = ['#eb459e', '#3ba55d', '#9b59b6', '#e67e22', '#1abc9c', '#e74c3c', '#3498db', '#f1c40f'];
  const ERRORS = {
    'bad-code': 'Código inválido. Confira com quem criou a sala.',
    full: 'A sala está cheia (8 pessoas).',
  };
  const ICON_SCREEN =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>';
  const ICON_VOL =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
  const ICON_VOL_OFF =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>';
  // Tudo de áudio abaixo é pessoal: fica neste navegador e só muda o que você ouve ou envia.
  const AUDIO_PRESETS = [
    { id: 'eco', name: 'Econômico', sub: '32 kbps · pouca banda', bitrate: 32, ns: true, echo: true, agc: true },
    { id: 'padrao', name: 'Padrão', sub: '64 kbps · equilibrado', bitrate: 64, ns: true, echo: true, agc: true },
    { id: 'alta', name: 'Alta', sub: '128 kbps · voz nítida', bitrate: 128, ns: true, echo: true, agc: false },
    { id: 'estudio', name: 'Estúdio', sub: '256 kbps · sem tratamento', bitrate: 256, ns: false, echo: false, agc: false },
  ];
  const BITRATE_MIN = 16;
  const BITRATE_MAX = 320;
  const MIC_VOL_MAX = 150;
  const PEER_VOL_MAX = 200;
  const SPEAK_THRESHOLD = 0.02;
  const SPEAK_HOLD_MS = 300;
  // Em malha, quem compartilha envia o vídeo uma vez por espectador: o limite protege o upload.
  const SHARE_MAX_HEIGHT = 720;
  const SHARE_MAX_BITRATE = 1_000_000;
  const SHARE_MAX_FPS = 15;
  // O servidor segura a vaga por 30 s depois de uma queda; tentamos um pouco além disso.
  const RECONNECT_GIVEUP_MS = 45000;
  const HEARTBEAT_MS = 10000;
  const HEARTBEAT_STALE_MS = 30000;
  const MAX_OUTBOX = 200;

  const state = {
    ws: null,
    myId: null,
    myName: '',
    code: '',
    stream: null,
    rawStream: null,
    micGain: null,
    micAnalyser: null,
    levelTimer: null,
    openPeer: null,
    audio: null,
    mix: null,
    muted: false,
    speaking: false,
    screen: null,
    sharerId: null,
    token: null,
    reconnecting: false,
    reconnectStarted: 0,
    retryTimer: null,
    heartbeatTimer: null,
    lastRx: 0,
    outbox: [],
    shareSince: 0,
    fill: false,
    theater: false,
    shareTimer: null,
    peers: new Map(),
    iceConfig: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
    audioCtx: null,
    meter: null,
    meterTimers: new Map(),
  };

  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
  };

  function colorFor(id) {
    return COLORS[Number(id) % COLORS.length];
  }

  /* ---------- preferências de áudio (só deste navegador) ---------- */

  function loadAudioPrefs() {
    let saved = null;
    try { saved = JSON.parse(store.get('discotavo.audio')); } catch { /* usa o padrão */ }
    if (!saved || typeof saved !== 'object') saved = {};
    const num = (v, min, max, fallback) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
    const flag = (v) => (typeof v === 'boolean' ? v : true);
    return {
      bitrate: num(saved.bitrate, BITRATE_MIN, BITRATE_MAX, 64),
      ns: flag(saved.ns),
      echo: flag(saved.echo),
      agc: flag(saved.agc),
      micVol: num(saved.micVol, 0, MIC_VOL_MAX, 100),
    };
  }

  function saveAudioPrefs() {
    store.set('discotavo.audio', JSON.stringify(state.audio));
  }

  // Volume e mudo de cada pessoa, guardados pelo nome (o id muda a cada entrada na sala).
  function loadMix() {
    try {
      const saved = JSON.parse(store.get('discotavo.mix'));
      return saved && typeof saved === 'object' ? saved : {};
    } catch {
      return {};
    }
  }

  function mixKey(name) {
    return name.trim().toLowerCase();
  }

  function mixFor(name) {
    const saved = state.mix[mixKey(name)];
    const vol = saved && Number.isFinite(saved.vol) ? Math.min(PEER_VOL_MAX, Math.max(0, saved.vol)) : 100;
    return { vol, localMuted: Boolean(saved && saved.muted) };
  }

  state.audio = loadAudioPrefs();
  state.mix = loadMix();

  /* ---------- entrada ---------- */

  const nameInput = $('name');
  const codeInput = $('code');
  const serverInput = $('server');
  nameInput.value = store.get('discotavo.name') || '';
  codeInput.value = decodeURIComponent(location.hash.slice(1));

  // No app desktop a interface vem do próprio app, então o endereço do servidor é informado
  // pelo usuário. No navegador é sempre a origem da página.
  const desktop = window.discotavoDesktop || null;
  let serverBase = desktop ? '' : location.origin; // no desktop só existe depois de enviar o formulário
  if (desktop) {
    $('server-field').hidden = false;
    serverInput.value = store.get('discotavo.server') || '';
    desktop.onToggleMute(toggleMute);
  }

  // Aceita o link completo da sala (https://host/#CODIGO) ou só o endereço do servidor.
  function parseRoomLink(text) {
    const raw = text.trim();
    if (!raw) return null;
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      return { origin: url.origin, code: decodeURIComponent(url.hash.slice(1)) };
    } catch {
      return null;
    }
  }

  function applyPasted(text) {
    const link = parseRoomLink(text);
    if (!link || !link.code) return false;
    if (desktop) {
      serverInput.value = link.origin;
    } else if (link.origin !== location.origin) {
      // O navegador só fala com o servidor que serviu a página.
      showJoinError('Esse link é de outro servidor. Abra-o direto no navegador ou no app desktop.');
      return true;
    }
    codeInput.value = link.code;
    return true;
  }

  // No campo do código só um link com esquema é tratado como link; o texto comum cola normalmente.
  function onPaste(input, needsScheme) {
    input.addEventListener('paste', (e) => {
      const text = e.clipboardData ? e.clipboardData.getData('text') : '';
      if ((!needsScheme || text.includes('://')) && applyPasted(text)) e.preventDefault();
    });
  }
  onPaste(codeInput, true);
  onPaste(serverInput, false);

  function showJoinError(text) {
    const el = $('join-error');
    el.textContent = text;
    el.hidden = !text;
  }

  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showJoinError('');
    if (desktop) {
      const link = parseRoomLink(serverInput.value);
      if (!link) {
        showJoinError('Informe o endereço do servidor (o link da sala).');
        return;
      }
      serverBase = link.origin;
    }
    $('join-btn').disabled = true;
    try {
      await join(nameInput.value.trim(), codeInput.value.trim());
      if (desktop) store.set('discotavo.server', serverBase); // só guarda um servidor que funcionou
    } catch (err) {
      cleanup();
      showJoinError(err.message || 'Não foi possível entrar na sala.');
      $('join-btn').disabled = false;
    }
  });

  async function join(name, code) {
    store.set('discotavo.name', name);
    state.myName = name;
    state.code = code;

    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await state.audioCtx.resume();

    try {
      const res = await fetch(`${serverBase}/config.json`, { cache: 'no-store' });
      if (res.ok) state.iceConfig = await res.json();
    } catch { /* usa o STUN padrão */ }

    try {
      const a = state.audio;
      state.rawStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: a.echo, noiseSuppression: a.ns, autoGainControl: a.agc, channelCount: 1 },
      });
      state.stream = routeMic(state.rawStream);
    } catch {
      stopTracks(state.rawStream);
      state.rawStream = null;
      state.stream = null; // entra só como ouvinte
    }

    await connectSocket();
    showRoom();
  }

  // O microfone passa por um ganho antes de ir para os pares: é o que permite o controle de volume.
  function routeMic(raw) {
    const ctx = state.audioCtx;
    const gain = ctx.createGain();
    gain.gain.value = state.audio.micVol / 100;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const dest = ctx.createMediaStreamDestination();
    const source = ctx.createMediaStreamSource(raw);
    source.connect(gain);
    gain.connect(dest);
    gain.connect(analyser);
    state.micGain = gain;
    state.micAnalyser = analyser;
    return dest.stream;
  }

  function stopTracks(stream) {
    if (stream) for (const t of stream.getTracks()) t.stop();
  }

  function connectSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(socketUrl());
      state.ws = ws;
      let joined = false;

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'join', code: state.code, name: state.myName }));
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        state.lastRx = Date.now();
        if (!joined) {
          if (msg.type === 'joined') {
            joined = true;
            state.myId = msg.id;
            state.token = msg.token;
            state.sharerId = msg.sharer || null;
            state.shareSince = msg.sharer ? Date.now() - (msg.sharedFor || 0) : 0;
            for (const p of msg.peers) addPeer(p);
            resolve();
            for (const p of msg.peers) callPeer(p.id);
          } else if (msg.type === 'error') {
            reject(new Error(ERRORS[msg.reason] || 'Não foi possível entrar na sala.'));
          }
          return;
        }
        handleMessage(msg);
      });
      ws.addEventListener('error', () => {
        if (!joined) reject(new Error('Não foi possível conectar ao servidor.'));
      });
      ws.addEventListener('close', () => {
        if (!joined) reject(new Error('Conexão encerrada pelo servidor.'));
        else if (state.ws === ws) onSocketLost();
      });
    });
  }

  function socketUrl() {
    const base = new URL(serverBase);
    return `${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}/ws`;
  }

  /* ---------- queda e retomada da conexão com o servidor ---------- */

  // O áudio e a tela vão direto entre os navegadores; a conexão com o servidor só carrega
  // a sinalização. Se ela cair, as conexões ficam de pé e só religamos a sinalização.
  function onSocketLost() {
    if (state.reconnecting || !state.token) return;
    state.reconnecting = true;
    state.reconnectStarted = Date.now();
    setConnected(false);
    scheduleReconnect(1000);
  }

  function scheduleReconnect(delay) {
    state.retryTimer = setTimeout(() => {
      if (Date.now() - state.reconnectStarted > RECONNECT_GIVEUP_MS) {
        leave('Conexão com o servidor perdida.');
        return;
      }
      const ws = new WebSocket(socketUrl());
      state.ws = ws;
      let resumed = false;
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'resume', token: state.token }));
      });
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        state.lastRx = Date.now();
        if (resumed) return handleMessage(msg);
        if (msg.type === 'resumed') {
          resumed = true;
          onResumed(msg);
        } else if (msg.type === 'error') {
          leave('A sessão expirou. Entre na sala de novo.');
        }
      });
      ws.addEventListener('close', () => {
        if (state.ws !== ws) return;
        if (resumed) onSocketLost();
        else scheduleReconnect(Math.min(delay * 2, 8000));
      });
    }, delay);
  }

  // Alinha o que mudou na sala durante a queda: quem saiu, quem entrou, nomes e mutes.
  function onResumed(msg) {
    state.reconnecting = false;
    state.sharerId = msg.sharer || null;
    state.shareSince = msg.sharer ? Date.now() - (msg.sharedFor || 0) : 0;
    const present = new Set(msg.peers.map((p) => p.id));
    for (const id of [...state.peers.keys()]) if (!present.has(id)) removePeer(id);
    for (const p of msg.peers) {
      const known = state.peers.get(p.id);
      if (known) { known.name = p.name; known.muted = p.muted; } else addPeer(p);
    }
    // Quem entrou durante a queda nos chama sozinho: a offer dele ficou guardada no servidor.
    const pending = state.outbox.splice(0);
    for (const m of pending) send(m);
    send({ type: 'state', muted: state.muted });
    if (state.screen) {
      state.sharerId = state.myId;
      send({ type: 'share', on: true });
    }
    setConnected(true);
    render();
    refreshAudioPanel();
  }

  function setConnected(ok) {
    $('status-dot').classList.toggle('off', !ok);
    $('status-text').textContent = ok ? 'Conectado à sala' : 'Reconectando…';
    $('me-status').textContent = ok ? 'Conectado' : 'Reconectando…';
    $('me-status').classList.toggle('off', !ok);
  }

  // Uma conexão que morreu sem avisar (comum atrás de proxies) não gera 'close' por muito tempo.
  function startHeartbeat() {
    clearInterval(state.heartbeatTimer);
    state.lastRx = Date.now();
    state.heartbeatTimer = setInterval(() => {
      if (state.reconnecting || !state.ws) return;
      if (Date.now() - state.lastRx > HEARTBEAT_STALE_MS) {
        const dead = state.ws;
        state.ws = null;
        dead.close();
        onSocketLost();
        return;
      }
      send({ type: 'hb' });
    }, HEARTBEAT_MS);
  }

  /* ---------- mensagens do servidor ---------- */

  function handleMessage(msg) {
    switch (msg.type) {
      case 'peer-joined':
        addPeer(msg.peer);
        render();
        refreshAudioPanel();
        break;
      case 'peer-left':
        removePeer(msg.id);
        render();
        refreshAudioPanel();
        break;
      case 'peer-state': {
        const peer = state.peers.get(msg.id);
        if (peer) { peer.muted = msg.muted; render(); }
        break;
      }
      case 'signal':
        onSignal(msg.from, msg.data);
        break;
      case 'share':
        state.sharerId = msg.id;
        state.shareSince = msg.id ? Date.now() : 0;
        render();
        break;
      case 'sound': {
        const peer = state.peers.get(msg.id);
        const sound = sounds.find((x) => x.id === msg.sound);
        if (peer && sound) { playSound(sound); toastSound(`${peer.name} tocou ${sound.name}`); }
        break;
      }
      case 'share-denied':
        stopShare();
        warn('Outra pessoa já está compartilhando a tela.');
        break;
    }
  }

  function send(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    } else if (state.reconnecting && msg.type === 'signal' && state.outbox.length < MAX_OUTBOX) {
      state.outbox.push(msg); // a sinalização não se refaz sozinha: guarda até reconectar
    }
  }

  /* ---------- pares (WebRTC mesh) ---------- */

  function addPeer(info) {
    if (state.peers.has(info.id)) return;
    state.peers.set(info.id, {
      id: info.id, name: info.name, muted: info.muted,
      pc: null, audio: null, speaking: false, queue: Promise.resolve(),
      ...mixFor(info.name), gain: null, source: null, audioSender: null,
      videoStream: null, videoSender: null, makingOffer: false, ignoreOffer: false,
    });
  }

  function removePeer(id) {
    const peer = state.peers.get(id);
    if (!peer) return;
    closePeer(peer);
    state.peers.delete(id);
  }

  function closePeer(peer) {
    stopMeter(peer.id);
    if (peer.pc) { peer.pc.close(); peer.pc = null; }
    peer.videoStream = null;
    peer.videoSender = null;
    peer.audioSender = null;
    disconnectPlayback(peer);
    if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); peer.audio = null; }
  }

  // "Perfect negotiation": qualquer lado pode renegociar (ex.: ao ligar a tela) e, se as
  // offers colidirem, o lado "educado" desiste da dele e aceita a do outro.
  function isPolite(peer) {
    return Number(state.myId) > Number(peer.id);
  }

  function ensurePc(peer, initiator = false) {
    if (peer.pc) return peer.pc;
    const pc = new RTCPeerConnection(state.iceConfig);
    peer.pc = pc;

    pc.addEventListener('negotiationneeded', async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        send({ type: 'signal', to: peer.id, data: { description: pc.localDescription } });
      } catch (err) {
        console.warn('Falha ao negociar', err);
      } finally {
        peer.makingOffer = false;
      }
    });
    pc.addEventListener('signalingstatechange', () => {
      if (pc.signalingState === 'stable') { limitVideo(peer); applyBitrate(peer); }
    });

    if (state.stream) {
      for (const track of state.stream.getAudioTracks()) peer.audioSender = pc.addTrack(track, state.stream);
    } else if (initiator) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    if (state.screen) addVideo(peer);

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) send({ type: 'signal', to: peer.id, data: { candidate: e.candidate } });
    });
    pc.addEventListener('track', (e) => {
      if (e.track.kind === 'video') {
        peer.videoStream = e.streams[0] || new MediaStream([e.track]);
        render();
        return;
      }
      const remote = e.streams[0] || new MediaStream([e.track]);
      if (!peer.audio) {
        peer.audio = document.createElement('audio');
        peer.audio.autoplay = true;
        $('audio-sink').appendChild(peer.audio);
      }
      peer.audio.srcObject = remote;
      // O elemento só mantém o fluxo vivo (mudo); quem toca é o ganho, que permite 0–200%.
      peer.audio.muted = true;
      connectPlayback(peer, remote);
      startMeter(peer.id, remote, (on) => { peer.speaking = on; render(); });
    });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') {
        warn(`Não foi possível conectar com ${peer.name}. Talvez a rede dele precise de um servidor TURN.`);
      }
    });
    return pc;
  }

  // Quem entra puxa a conversa: criar a conexão com as faixas dispara o 'negotiationneeded'.
  function callPeer(id) {
    const peer = state.peers.get(id);
    if (peer) ensurePc(peer, true);
  }

  function onSignal(from, data) {
    const peer = state.peers.get(from);
    if (!peer || !data) return;
    enqueue(peer, async () => {
      const pc = ensurePc(peer);
      if (data.description) {
        const collision = data.description.type === 'offer' &&
          (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !isPolite(peer) && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          send({ type: 'signal', to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    });
  }

  /* ---------- volume e mudo de cada pessoa (só para você) ---------- */

  function connectPlayback(peer, remote) {
    const ctx = state.audioCtx;
    if (!ctx) { peer.audio.muted = false; return; }
    disconnectPlayback(peer);
    peer.source = ctx.createMediaStreamSource(remote);
    peer.gain = ctx.createGain();
    peer.gain.gain.value = peer.localMuted ? 0 : peer.vol / 100;
    peer.source.connect(peer.gain);
    peer.gain.connect(ctx.destination);
  }

  function disconnectPlayback(peer) {
    if (peer.source) { peer.source.disconnect(); peer.source = null; }
    if (peer.gain) { peer.gain.disconnect(); peer.gain = null; }
  }

  function setPeerMix(peer, patch) {
    Object.assign(peer, patch);
    const key = mixKey(peer.name);
    if (peer.vol === 100 && !peer.localMuted) delete state.mix[key];
    else state.mix[key] = { vol: peer.vol, muted: peer.localMuted };
    store.set('discotavo.mix', JSON.stringify(state.mix));
    if (peer.gain && state.audioCtx) {
      peer.gain.gain.setTargetAtTime(peer.localMuted ? 0 : peer.vol / 100, state.audioCtx.currentTime, 0.02);
    }
    refreshMixerRow(peer);
    refreshMixerAll();
    render();
  }

  /* ---------- qualidade do áudio que você envia ---------- */

  function applyBitrate(peer) {
    if (!peer.audioSender) return;
    try {
      const params = peer.audioSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) return;
      params.encodings[0].maxBitrate = state.audio.bitrate * 1000;
      peer.audioSender.setParameters(params).catch(() => {});
    } catch { /* o navegador pode não aceitar ainda; tenta de novo ao estabilizar */ }
  }

  function applyBitrateAll() {
    for (const peer of state.peers.values()) applyBitrate(peer);
  }

  async function applyMicConstraints() {
    const track = state.rawStream && state.rawStream.getAudioTracks()[0];
    if (!track) return;
    const a = state.audio;
    try {
      await track.applyConstraints({ echoCancellation: a.echo, noiseSuppression: a.ns, autoGainControl: a.agc });
      audioStatus('');
    } catch {
      audioStatus('O navegador não aplicou essa mudança agora. Ela vale na próxima vez que você entrar.');
    }
  }

  function qualityName(bitrate) {
    return bitrate < 48 ? 'Econômico' : bitrate < 96 ? 'Padrão' : bitrate < 192 ? 'Alta qualidade' : 'Estúdio';
  }

  function audioStatus(text) {
    const node = $('audio-status');
    node.textContent = text;
    node.hidden = !text;
  }

  /* ---------- painel de áudio ---------- */

  const mixerRows = new Map();
  const presetButtons = new Map();

  for (const preset of AUDIO_PRESETS) {
    const btn = el('button', 'preset');
    btn.type = 'button';
    btn.append(el('b', '', preset.name), el('span', '', preset.sub));
    btn.addEventListener('click', () => {
      Object.assign(state.audio, { bitrate: preset.bitrate, ns: preset.ns, echo: preset.echo, agc: preset.agc });
      saveAudioPrefs();
      applyBitrateAll();
      applyMicConstraints();
      refreshQualityForm();
    });
    presetButtons.set(preset.id, btn);
  }
  $('presets').replaceChildren(...presetButtons.values());

  function openAudio() {
    audioStatus('');
    $('audio-panel').hidden = false;
    renderMixer();
    startLevel();
    $('audio-close').focus();
  }

  function closeAudio() {
    if ($('audio-panel').hidden) return;
    $('audio-panel').hidden = true;
    stopLevel();
    if (!$('room-screen').hidden) $('audio-btn').focus();
  }

  function refreshAudioPanel() {
    if (!$('audio-panel').hidden) renderMixer();
  }

  function renderMixer() {
    mixerRows.clear();
    const peers = [...state.peers.values()];
    $('mixer-empty').hidden = peers.length > 0;
    $('mixer-actions').hidden = peers.length === 0;
    $('mixer').replaceChildren(...peers.map((peer) => {
      const id = `vol-${peer.id}`;
      const li = el('li', 'mixer-row');
      const av = el('div', 'avatar', initial(peer.name));
      av.style.background = colorFor(peer.id);
      const label = el('label', 'mixer-name', peer.name);
      label.htmlFor = id;
      const out = el('output', 'mixer-val');
      out.htmlFor = id;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.id = id;
      slider.min = '0';
      slider.max = String(PEER_VOL_MAX);
      slider.step = '5';
      slider.addEventListener('input', () => setPeerMix(peer, { vol: Number(slider.value), localMuted: false }));
      const btn = el('button', 'icon-btn');
      btn.type = 'button';
      btn.addEventListener('click', () => setPeerMix(peer, { localMuted: !peer.localMuted }));
      const body = el('div', 'mixer-body');
      const top = el('div', 'mixer-top');
      top.append(label, out);
      body.append(top, slider);
      li.append(av, body, btn);
      mixerRows.set(peer.id, { li, slider, out, btn });
      refreshMixerRow(peer);
      return li;
    }));
    refreshMixerAll();
    refreshQualityForm();
  }

  function refreshMixerRow(peer) {
    const row = mixerRows.get(peer.id);
    if (!row) return;
    row.slider.value = String(peer.vol);
    row.out.textContent = peer.localMuted ? 'Mudo' : `${peer.vol}%`;
    row.out.classList.toggle('boost', !peer.localMuted && peer.vol > 100);
    row.li.classList.toggle('is-muted', peer.localMuted);
    row.btn.innerHTML = peer.localMuted ? ICON_VOL_OFF : ICON_VOL;
    row.btn.classList.toggle('is-muted', peer.localMuted);
    row.btn.setAttribute('aria-pressed', String(peer.localMuted));
    const label = `${peer.localMuted ? 'Reativar o som de' : 'Silenciar'} ${peer.name} só para você`;
    row.btn.setAttribute('aria-label', label);
    row.btn.title = label;
  }

  function refreshMixerAll() {
    const peers = [...state.peers.values()];
    const allMuted = peers.length > 0 && peers.every((p) => p.localMuted);
    $('mixer-mute-all').textContent = allMuted ? 'Reativar todos' : 'Silenciar todos';
    $('mixer-mute-all').setAttribute('aria-pressed', String(allMuted));
  }

  function refreshQualityForm() {
    const a = state.audio;
    const hasMic = Boolean(state.stream);
    $('mic-section').disabled = !hasMic;
    $('mic-missing').hidden = hasMic;
    $('quality-name').textContent = qualityName(a.bitrate);
    $('bitrate').value = String(a.bitrate);
    $('bitrate-out').textContent = `${a.bitrate} kbps`;
    const n = state.peers.size;
    $('upload-note').textContent = n === 0
      ? 'Ninguém mais na sala ainda.'
      : `Cada pessoa recebe o seu áudio direto de você: ${n} × ${a.bitrate} = ${n * a.bitrate} kbps de upload.`;
    $('mic-vol').value = String(a.micVol);
    $('mic-vol-out').textContent = `${a.micVol}%`;
    $('opt-ns').checked = a.ns;
    $('opt-echo').checked = a.echo;
    $('opt-agc').checked = a.agc;
    for (const preset of AUDIO_PRESETS) {
      const on = preset.bitrate === a.bitrate && preset.ns === a.ns && preset.echo === a.echo && preset.agc === a.agc;
      presetButtons.get(preset.id).setAttribute('aria-pressed', String(on));
    }
  }

  $('bitrate').min = String(BITRATE_MIN);
  $('bitrate').max = String(BITRATE_MAX);
  $('mic-vol').max = String(MIC_VOL_MAX);
  $('bitrate').addEventListener('input', (e) => {
    state.audio.bitrate = Number(e.target.value);
    saveAudioPrefs();
    applyBitrateAll();
    refreshQualityForm();
  });
  $('mic-vol').addEventListener('input', (e) => {
    state.audio.micVol = Number(e.target.value);
    saveAudioPrefs();
    if (state.micGain) state.micGain.gain.value = state.audio.micVol / 100;
    refreshQualityForm();
  });
  for (const [id, key] of [['opt-ns', 'ns'], ['opt-echo', 'echo'], ['opt-agc', 'agc']]) {
    $(id).addEventListener('change', (e) => {
      state.audio[key] = e.target.checked;
      saveAudioPrefs();
      applyMicConstraints();
      refreshQualityForm();
    });
  }
  $('mixer-mute-all').addEventListener('click', () => {
    const peers = [...state.peers.values()];
    const mute = !peers.every((p) => p.localMuted);
    for (const peer of peers) setPeerMix(peer, { localMuted: mute });
  });
  $('mixer-reset').addEventListener('click', () => {
    for (const peer of state.peers.values()) setPeerMix(peer, { vol: 100, localMuted: false });
  });
  $('audio-btn').addEventListener('click', openAudio);
  $('audio-close').addEventListener('click', closeAudio);
  $('audio-panel').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAudio(); });
  $('audio-panel').addEventListener('click', (e) => { if (e.target === $('audio-panel')) closeAudio(); });

  // Nível do microfone enquanto o painel está aberto. Mostra o sinal antes do mudo.
  function startLevel() {
    stopLevel();
    const analyser = state.micAnalyser;
    $('mic-level').style.width = '0%';
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);
    state.levelTimer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
      const level = Math.min(1, Math.sqrt(sum / data.length) * 3);
      $('mic-level').style.width = `${Math.round(level * 100)}%`;
      $('mic-level').classList.toggle('hot', level > 0.85);
    }, 80);
  }

  function stopLevel() {
    clearInterval(state.levelTimer);
    state.levelTimer = null;
  }

  /* ---------- compartilhamento de tela ---------- */

  function addVideo(peer) {
    const track = state.screen && state.screen.getVideoTracks()[0];
    if (!track || !peer.pc || peer.videoSender) return;
    peer.videoSender = peer.pc.addTrack(track, state.screen);
    limitVideo(peer);
  }

  function removeVideo(peer) {
    if (peer.videoSender && peer.pc) {
      try { peer.pc.removeTrack(peer.videoSender); } catch { /* conexão já fechada */ }
    }
    peer.videoSender = null;
  }

  function limitVideo(peer) {
    const track = state.screen && state.screen.getVideoTracks()[0];
    if (!peer.videoSender || !track) return;
    try {
      const params = peer.videoSender.getParameters();
      if (!params.encodings || params.encodings.length === 0) return;
      const height = track.getSettings().height || SHARE_MAX_HEIGHT;
      params.encodings[0].maxBitrate = SHARE_MAX_BITRATE;
      params.encodings[0].maxFramerate = SHARE_MAX_FPS;
      params.encodings[0].scaleResolutionDownBy = Math.max(1, height / SHARE_MAX_HEIGHT);
      peer.videoSender.setParameters(params).catch(() => {});
    } catch { /* o navegador pode não aceitar ainda; tenta de novo ao estabilizar */ }
  }

  async function startShare() {
    if (state.screen || (state.sharerId && state.sharerId !== state.myId)) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { height: { max: SHARE_MAX_HEIGHT }, frameRate: { max: SHARE_MAX_FPS } },
        audio: false,
      });
    } catch {
      return; // cancelado ou sem permissão
    }
    // Enquanto o seletor estava aberto, a sala pode ter mudado.
    if (!state.ws || state.sharerId) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    state.screen = stream;
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.addEventListener('ended', stopShare); // botão "parar" do próprio navegador
    state.sharerId = state.myId;
    state.shareSince = Date.now();
    send({ type: 'share', on: true });
    for (const peer of state.peers.values()) addVideo(peer);
    render();
  }

  function stopShare() {
    const stream = state.screen;
    if (!stream) return;
    state.screen = null;
    for (const peer of state.peers.values()) removeVideo(peer);
    for (const t of stream.getTracks()) t.stop();
    if (state.sharerId === state.myId) state.sharerId = null;
    state.shareSince = 0;
    send({ type: 'share', on: false });
    render();
  }

  // Serializa a negociação de cada par para evitar corridas entre offer/answer/candidates.
  function enqueue(peer, task) {
    peer.queue = peer.queue.then(task).catch((err) => console.warn('Falha na sinalização', err));
  }

  /* ---------- indicador de quem está falando ---------- */

  function startMeter(key, stream, onChange) {
    stopMeter(key);
    if (!state.audioCtx || stream.getAudioTracks().length === 0) return;
    const analyser = state.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    state.audioCtx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let on = false;
    let lastLoud = 0;
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / data.length);
      const now = performance.now();
      if (rms > SPEAK_THRESHOLD) lastLoud = now;
      const next = now - lastLoud < SPEAK_HOLD_MS;
      if (next !== on) { on = next; onChange(on); }
    }, 100);
    state.meterTimers.set(key, timer);
  }

  function stopMeter(key) {
    const timer = state.meterTimers.get(key);
    if (timer) { clearInterval(timer); state.meterTimers.delete(key); }
  }

  /* ---------- sala ---------- */

  function showRoom() {
    $('join-screen').hidden = true;
    $('room-screen').hidden = false;
    setConnected(true);
    startHeartbeat();
    clearInterval(state.shareTimer);
    state.shareTimer = setInterval(updateShareTime, 1000);
    $('room-code').textContent = state.code.toUpperCase();
    $('me-name').textContent = state.myName;
    $('me-avatar').textContent = initial(state.myName);
    $('me-status').textContent = 'Conectado';
    $('status-dot').classList.remove('off');
    $('room-warning').hidden = !!state.stream;
    if (!state.stream) {
      $('room-warning').textContent = 'Sem acesso ao microfone: você só consegue ouvir.';
    }
    if (state.stream) {
      startMeter('me', state.stream, (on) => { state.speaking = on; render(); });
    }
    render();
    showWelcome();
  }

  /* ---------- boas-vindas ao entrar ---------- */

  function showWelcome() {
    $('welcome-hello').textContent = `Oi, ${state.myName}`;
    const others = state.peers.size;
    const who = others === 0 ? 'Você é o primeiro por aqui.'
      : `Tem ${others} ${others === 1 ? 'pessoa' : 'pessoas'} na sala agora.`;
    $('welcome-sub').textContent = `Pode entrar, ninguém aqui vai julgar a sua mira. ${who}`;
    $('welcome-mic').textContent = state.stream ? 'Microfone ligado' : 'Sem microfone: você só ouve';
    $('welcome-mic').parentElement.classList.toggle('off', !state.stream);
    $('welcome').hidden = false;
    $('welcome-close').focus();
  }

  function hideWelcome() {
    if ($('welcome').hidden) return;
    $('welcome').hidden = true;
    if (!$('room-screen').hidden) $('mute-btn').focus();
  }
  $('welcome-close').addEventListener('click', hideWelcome);
  $('welcome').addEventListener('keydown', (e) => { if (e.key === 'Escape') hideWelcome(); });
  $('welcome').addEventListener('click', (e) => { if (e.target === $('welcome')) hideWelcome(); });

  function warn(text) {
    const el = $('room-warning');
    el.textContent = text;
    el.hidden = false;
  }

  function initial(name) {
    return (name.trim()[0] || '?').toUpperCase();
  }

  function render() {
    if ($('room-screen').hidden) return;
    const mutedNow = state.muted || !state.stream;
    const everyone = [
      {
        id: state.myId, name: state.myName + ' (você)', letter: initial(state.myName),
        color: '#5865f2', muted: mutedNow, speaking: state.speaking && !state.muted,
        sharing: Boolean(state.screen),
      },
      ...[...state.peers.values()].map((p) => ({
        id: p.id, name: p.name, letter: initial(p.name),
        color: colorFor(p.id), muted: p.muted, speaking: p.speaking && !p.muted,
        sharing: state.sharerId === p.id, peer: p,
      })),
    ];

    const count = `${everyone.length}/8`;
    $('count-side').textContent = count;
    $('count-head').textContent = count;

    renderSidebar(everyone);

    $('tiles').replaceChildren(...everyone.map((p) => {
      const tile = el('div', 'tile' + (p.speaking ? ' speaking' : ''));
      const av = el('div', 'avatar', p.letter);
      av.style.background = p.color;
      tile.append(av, el('div', 'tag', p.name));
      if (p.muted) {
        const badge = iconSpan(ICON_MIC_OFF, '', 16, 'Mutado');
        badge.className = 'mute-badge';
        tile.append(badge);
      }
      return tile;
    }));

    renderScreen();

    const mute = $('mute-btn');
    const mini = $('mute-mini');
    mute.disabled = !state.stream;
    mute.classList.toggle('is-muted', mutedNow);
    mute.innerHTML = mutedNow ? ICON_MIC_OFF : ICON_MIC;
    const label = !state.stream ? 'Sem microfone' : state.muted ? 'Ativar microfone' : 'Mutar microfone';
    mute.setAttribute('aria-label', label);
    mute.title = label;
    mini.disabled = !state.stream;
    mini.classList.toggle('is-muted', mutedNow);
    mini.innerHTML = mutedNow ? ICON_MIC_OFF : ICON_MIC;
    mini.setAttribute('aria-label', label);
  }

  /* ---------- lista lateral: clique numa pessoa para ajustar o volume ---------- */

  const sideRows = new Map();
  const ICON_CHEVRON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  // As linhas são criadas uma vez e só atualizadas: refazer o controle de volume no meio do
  // arraste (o render roda a cada mudança de quem fala) cancelaria o gesto.
  function renderSidebar(everyone) {
    const list = $('people-list');
    const keep = new Set(everyone.map((p) => String(p.id)));
    for (const key of [...sideRows.keys()]) if (!keep.has(key)) sideRows.delete(key);
    const items = everyone.map((p) => {
      const key = String(p.id);
      let row = sideRows.get(key);
      if (!row || row.peer !== p.peer) {
        row = createSideRow(p);
        sideRows.set(key, row);
      }
      updateSideRow(row, p);
      return row.li;
    });
    const same = list.children.length === items.length && items.every((li, i) => list.children[i] === li);
    if (!same) list.replaceChildren(...items);
  }

  function createSideRow(p) {
    const li = el('li', 'person');
    const peer = p.peer;
    const row = { li, peer, key: String(p.id) };
    if (!peer) {
      row.head = el('div', 'person-head');
      li.append(row.head);
      return row;
    }
    row.head = el('button', 'person-head');
    row.head.type = 'button';
    row.head.addEventListener('click', () => {
      state.openPeer = state.openPeer === row.key ? null : row.key;
      render();
    });

    const id = `side-vol-${peer.id}`;
    row.panel = el('div', 'person-panel');
    const label = el('label', '', 'Volume');
    label.htmlFor = id;
    row.out = el('output', 'mixer-val');
    row.out.htmlFor = id;
    const top = el('div', 'mixer-top');
    top.append(label, row.out);
    row.slider = document.createElement('input');
    row.slider.type = 'range';
    row.slider.id = id;
    row.slider.min = '0';
    row.slider.max = String(PEER_VOL_MAX);
    row.slider.step = '5';
    row.slider.addEventListener('input', () => setPeerMix(peer, { vol: Number(row.slider.value), localMuted: false }));
    row.muteBtn = el('button', 'chip-btn');
    row.muteBtn.type = 'button';
    row.muteBtn.addEventListener('click', () => setPeerMix(peer, { localMuted: !peer.localMuted }));
    const reset = el('button', 'chip-btn', '100%');
    reset.type = 'button';
    reset.title = 'Voltar o volume para 100%';
    reset.addEventListener('click', () => setPeerMix(peer, { vol: 100, localMuted: false }));
    const actions = el('div', 'settings-actions');
    actions.append(row.muteBtn, reset);
    row.panel.append(top, row.slider, actions);
    li.append(row.head, row.panel);
    return row;
  }

  function updateSideRow(row, p) {
    const peer = p.peer;
    const open = Boolean(peer) && state.openPeer === row.key;
    row.li.className = 'person' + (p.speaking ? ' speaking' : '') + (open ? ' open' : '');
    const av = el('div', 'avatar', p.letter);
    av.style.background = p.color;
    const parts = [av, el('span', 'name', p.name)];
    if (p.sharing) parts.push(iconSpan(ICON_SCREEN, 'var(--blurple)', 18, 'Compartilhando a tela'));
    if (p.muted) parts.push(iconSpan(ICON_MIC_OFF, 'var(--red)', 18, 'Mutado'));
    if (peer && peer.localMuted) parts.push(iconSpan(ICON_VOL_OFF, '#f0b232', 18, 'Silenciado só para você'));
    if (peer) {
      const chevron = iconSpan(ICON_CHEVRON, 'var(--dim)', 16);
      chevron.classList.add('chevron');
      parts.push(chevron);
      row.head.setAttribute('aria-expanded', String(open));
      row.head.title = `Ajustar o volume de ${peer.name}`;
      row.panel.hidden = !open;
      row.slider.value = String(peer.vol);
      row.out.textContent = peer.localMuted ? 'Mudo' : `${peer.vol}%`;
      row.out.classList.toggle('boost', !peer.localMuted && peer.vol > 100);
      row.muteBtn.textContent = peer.localMuted ? 'Reativar o som' : 'Silenciar para mim';
      row.muteBtn.setAttribute('aria-pressed', String(peer.localMuted));
    }
    row.head.replaceChildren(...parts);
  }

  function renderScreen() {
    const sharer = state.sharerId && state.sharerId !== state.myId ? state.peers.get(state.sharerId) : null;
    const mine = Boolean(state.screen);
    const active = Boolean(sharer) || mine;
    $('screen-view').hidden = !active;
    $('tiles').classList.toggle('with-screen', active);
    if (!active) state.theater = false;
    $('room-screen').classList.toggle('theater', state.theater);

    const stream = sharer ? sharer.videoStream : null;
    const video = $('screen-video');
    if (video.srcObject !== stream) video.srcObject = stream;
    const appeared = video.hidden && Boolean(stream);
    video.hidden = !stream;
    if (appeared) wakePlayer();
    $('player-stage').classList.toggle('fill', state.fill);
    $('pbar').hidden = !stream;
    if (!stream) $('player').classList.remove('idle');

    const who = mine ? { name: 'Você', letter: initial(state.myName), color: '#5865f2', speaking: state.speaking && !state.muted }
      : sharer ? { name: sharer.name, letter: initial(sharer.name), color: colorFor(sharer.id), speaking: sharer.speaking && !sharer.muted }
        : { name: '', letter: '', color: 'transparent', speaking: false };
    $('who-name').textContent = who.name;
    const avatar = $('who-avatar');
    avatar.textContent = who.letter;
    avatar.style.background = who.color;
    avatar.classList.toggle('speaking', who.speaking);

    const viewers = state.peers.size;
    $('viewers-text').textContent = viewers === 1 ? '1 assistindo' : `${viewers} assistindo`;
    $('screen-note').textContent = mine ? 'Os outros estão vendo a sua tela.' : stream ? '' : 'Carregando a tela…';
    $('screen-note').hidden = !$('screen-note').textContent;

    $('fit-text').textContent = state.fill ? 'Ajustar à janela' : 'Preencher';
    $('fit-btn').setAttribute('aria-pressed', String(state.fill));
    $('theater-btn').setAttribute('aria-pressed', String(state.theater));
    $('theater-btn').setAttribute('aria-label', state.theater ? 'Sair do modo teatro' : 'Modo teatro');
    $('theater-btn').title = state.theater ? 'Sair do modo teatro' : 'Modo teatro';
    const fullscreen = document.fullscreenElement === $('player');
    $('fs-btn').hidden = !$('player').requestFullscreen;
    $('fs-btn').setAttribute('aria-pressed', String(fullscreen));
    $('fs-btn').setAttribute('aria-label', fullscreen ? 'Sair da tela cheia' : 'Tela cheia');
    $('fs-btn').title = fullscreen ? 'Sair da tela cheia' : 'Tela cheia';
    $('pip-btn').hidden = !document.pictureInPictureEnabled;
    $('pip-btn').setAttribute('aria-pressed', String(document.pictureInPictureElement === video));

    const canShare = Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    const btn = $('share-btn');
    btn.disabled = !canShare || Boolean(sharer);
    btn.classList.toggle('is-sharing', mine);
    btn.innerHTML = ICON_SCREEN;
    const shareLabel = mine ? 'Parar de compartilhar a tela'
      : sharer ? `${sharer.name} já está compartilhando`
        : !canShare ? 'Seu navegador não suporta compartilhar a tela' : 'Compartilhar tela';
    btn.title = shareLabel;
    btn.setAttribute('aria-label', shareLabel);
    updateShareTime();
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  // Tempo no ar e qualidade que está chegando de fato (altura e fps do vídeo recebido).
  function updateShareTime() {
    if ($('room-screen').hidden) return;
    const time = state.shareSince ? formatTime(Date.now() - state.shareSince) : '0:00';
    $('share-time').textContent = time;
    if (state.screen) $('screen-note').textContent = `Os outros estão vendo a sua tela · ${time}`;
    const video = $('screen-video');
    const height = video.hidden ? 0 : video.videoHeight;
    $('quality-chip').hidden = !height;
    if (height) {
      const sharer = state.peers.get(state.sharerId);
      const track = sharer && sharer.videoStream && sharer.videoStream.getVideoTracks()[0];
      const fps = track ? Math.round(track.getSettings().frameRate || 0) : 0;
      $('quality-text').textContent = fps ? `${height}p · ${fps} fps` : `${height}p`;
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function iconSpan(svg, color, size, label) {
    const span = el('span', 'tag-icon');
    if (color) span.style.color = color;
    if (label) { span.setAttribute('role', 'img'); span.setAttribute('aria-label', label); }
    span.innerHTML = svg;
    span.firstChild.setAttribute('width', size);
    span.firstChild.setAttribute('height', size);
    return span;
  }

  function toggleMute() {
    if (!state.stream) return;
    state.muted = !state.muted;
    for (const t of state.stream.getAudioTracks()) t.enabled = !state.muted;
    send({ type: 'state', muted: state.muted });
    render();
  }
  $('mute-btn').addEventListener('click', toggleMute);
  $('mute-mini').addEventListener('click', toggleMute);
  $('share-btn').addEventListener('click', () => (state.screen ? stopShare() : startShare()));

  /* ---------- soundboard ---------- */

  // Os sons tocam só no alto-falante de cada um (não passam pelo microfone). Catálogo em public/sounds/sounds.json.
  let sounds = [];
  const soundBuffers = new Map();
  const soundPrefs = { vol: Number(store.get('sound-vol') ?? 70), mute: store.get('sound-mute') === '1' };
  soundPrefs.vol = Number.isFinite(soundPrefs.vol) ? Math.min(100, Math.max(0, soundPrefs.vol)) : 70;
  let toastTimer = null;

  fetch('sounds/sounds.json')
    .then((r) => r.json())
    .then((list) => { sounds = list; renderSounds(); })
    .catch(() => { $('sound-btn').hidden = true; });

  function renderSounds() {
    const make = (sound) => {
      const btn = el('button', 'sound-btn', sound.name);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        playSound(sound);
        send({ type: 'sound', sound: sound.id });
      });
      return btn;
    };
    $('sound-std').replaceChildren(...sounds.filter((s) => !s.mine).map(make));
    $('sound-mine').replaceChildren(...sounds.filter((s) => s.mine).map(make));
    $('sound-mine').closest('section').hidden = !sounds.some((s) => s.mine);
  }

  async function playSound(sound) {
    const ctx = state.audioCtx;
    if (!ctx || soundPrefs.mute || soundPrefs.vol === 0) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const out = ctx.createGain();
    out.gain.value = soundPrefs.vol / 100;
    out.connect(ctx.destination);
    if (sound.file) {
      try {
        if (!soundBuffers.has(sound.id)) {
          const data = await (await fetch(`sounds/${sound.file}`)).arrayBuffer();
          soundBuffers.set(sound.id, await ctx.decodeAudioData(data));
        }
        const src = ctx.createBufferSource();
        src.buffer = soundBuffers.get(sound.id);
        src.connect(out);
        src.start();
      } catch { /* arquivo ausente ou formato não suportado */ }
      return;
    }
    let t = ctx.currentTime;
    for (const [freq, dur, type] of sound.seq || []) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(env);
      env.connect(out);
      osc.start(t);
      osc.stop(t + dur);
      t += dur * 0.9;
    }
  }

  function toastSound(text) {
    const node = $('sound-toast');
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 2500);
  }

  function refreshSoundForm() {
    $('sound-vol').value = soundPrefs.vol;
    $('sound-vol-out').textContent = `${soundPrefs.vol}%`;
    $('sound-mute').setAttribute('aria-pressed', String(soundPrefs.mute));
  }
  function openSounds() {
    refreshSoundForm();
    $('sound-panel').hidden = false;
    $('sound-close').focus();
  }
  function closeSounds() {
    if ($('sound-panel').hidden) return;
    $('sound-panel').hidden = true;
    if (!$('room-screen').hidden) $('sound-btn').focus();
  }
  $('sound-vol').addEventListener('input', (e) => {
    soundPrefs.vol = Number(e.target.value);
    store.set('sound-vol', String(soundPrefs.vol));
    refreshSoundForm();
  });
  $('sound-mute').addEventListener('click', () => {
    soundPrefs.mute = !soundPrefs.mute;
    store.set('sound-mute', soundPrefs.mute ? '1' : '0');
    refreshSoundForm();
  });
  $('sound-btn').addEventListener('click', openSounds);
  $('sound-close').addEventListener('click', closeSounds);
  $('sound-panel').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSounds(); });
  $('sound-panel').addEventListener('click', (e) => { if (e.target === $('sound-panel')) closeSounds(); });

  /* ---------- controles do player ---------- */

  const player = $('player');
  const screenVideo = $('screen-video');
  $('fit-btn').addEventListener('click', () => { state.fill = !state.fill; renderScreen(); });
  $('theater-btn').addEventListener('click', () => { state.theater = !state.theater; renderScreen(); });
  $('fs-btn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else player.requestFullscreen().catch(() => {});
  });
  $('pip-btn').addEventListener('click', () => {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else screenVideo.requestPictureInPicture().catch(() => {});
  });
  document.addEventListener('fullscreenchange', renderScreen);
  screenVideo.addEventListener('enterpictureinpicture', renderScreen);
  screenVideo.addEventListener('leavepictureinpicture', renderScreen);
  screenVideo.addEventListener('loadedmetadata', updateShareTime);
  screenVideo.addEventListener('resize', updateShareTime);

  // Os controles somem depois de 3 s sem movimento e voltam ao mexer o mouse ou usar o teclado.
  let idleTimer = null;
  function wakePlayer() {
    player.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const busy = $('pbar').matches(':hover') || $('pbar').contains(document.activeElement);
      if (!screenVideo.hidden && !busy) player.classList.add('idle');
    }, 3000);
  }
  for (const ev of ['mousemove', 'pointerdown', 'keydown', 'focusin', 'touchstart']) {
    player.addEventListener(ev, wakePlayer);
  }
  wakePlayer();

  $('copy-btn').addEventListener('click', async () => {
    const link = `${serverBase}/#${state.code}`;
    const label = $('room-code');
    try {
      await navigator.clipboard.writeText(link);
      label.textContent = 'Link copiado!';
    } catch {
      label.textContent = 'Copie manualmente';
    }
    setTimeout(() => { label.textContent = state.code.toUpperCase(); }, 1500);
  });

  $('leave-btn').addEventListener('click', () => leave(''));
  window.addEventListener('beforeunload', () => cleanup());

  function cleanup() {
    const ws = state.ws;
    state.ws = null;
    clearTimeout(state.retryTimer);
    clearInterval(state.heartbeatTimer);
    state.reconnecting = false;
    state.token = null;
    state.outbox = [];
    if (ws) {
      // Saída de propósito: o servidor libera a vaga na hora em vez de esperar a retomada.
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'leave' }));
      ws.close();
    }
    for (const peer of state.peers.values()) closePeer(peer);
    state.peers.clear();
    stopMeter('me');
    stopLevel();
    sideRows.clear();
    state.openPeer = null;
    $('audio-panel').hidden = true;
    $('sound-panel').hidden = true;
    stopTracks(state.stream);
    stopTracks(state.rawStream);
    state.stream = null;
    state.rawStream = null;
    state.micGain = null;
    state.micAnalyser = null;
    if (state.screen) { for (const t of state.screen.getTracks()) t.stop(); state.screen = null; }
    state.sharerId = null;
    state.shareSince = 0;
    state.theater = false;
    $('welcome').hidden = true;
    clearInterval(state.shareTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    if (state.audioCtx) { state.audioCtx.close().catch(() => {}); state.audioCtx = null; }
    state.myId = null;
    state.muted = false;
    state.speaking = false;
  }

  function leave(reason) {
    cleanup();
    $('room-screen').hidden = true;
    $('join-screen').hidden = false;
    $('join-btn').disabled = false;
    showJoinError(reason);
    codeInput.value = state.code;
  }
})();
