'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { Room } = require('./room');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const USE_TUNNEL = !process.argv.includes('--no-tunnel');
const MAX_BAD_CODES = 5;

const room = new Room(
  process.env.ROOM_CODE || undefined,
  undefined,
  process.env.RESUME_GRACE_MS ? Number(process.env.RESUME_GRACE_MS) : undefined,
);
const sockets = new Map(); // id da pessoa -> conexão atual

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

// Sons permitidos: a lista de public/sounds/sounds.json, lida uma vez na partida.
let soundIds = new Set();
try {
  soundIds = new Set(JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'sounds', 'sounds.json'), 'utf8')).map((s) => s.id));
} catch (err) {
  console.warn('  sounds.json não carregou, soundboard desligado:', err.message);
}

function iceConfig() {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }
  return { iceServers };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/config.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(iceConfig()));
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Proibido');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Não encontrado');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

// Proxies como o Cloudflare derrubam WebSockets ociosos; o ping mantém o tráfego
// e o pong ausente revela conexões mortas.
const PING_INTERVAL_MS = 20000;
const pingTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, PING_INTERVAL_MS);
wss.on('close', () => clearInterval(pingTimer));

function log(...args) {
  console.log(new Date().toLocaleTimeString('pt-BR'), ...args);
}

wss.on('connection', (ws) => {
  const connectedAt = Date.now();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let peerId = null;
  let badCodes = 0;
  const send = (msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'hb') {
      send({ type: 'hb' });
      return;
    }

    if (peerId === null) {
      if (msg.type === 'resume') {
        const resumed = room.resume(msg.token, send);
        if (!resumed) {
          send({ type: 'error', reason: 'resume-failed' });
          if (++badCodes >= MAX_BAD_CODES) ws.close();
          return;
        }
        const old = sockets.get(resumed.id);
        if (old && old !== ws) {
          old.superseded = true;
          old.close();
        }
        sockets.set(resumed.id, ws);
        peerId = resumed.id;
        log(`pessoa ${peerId} retomou a sessão (${resumed.queued.length} sinais guardados)`);
        send({ type: 'resumed', id: peerId, peers: resumed.peers, sharer: resumed.sharer, sharedFor: resumed.sharedFor });
        for (const queued of resumed.queued) send(queued);
        return;
      }
      if (msg.type !== 'join') return;
      if (!room.checkCode(msg.code)) {
        send({ type: 'error', reason: 'bad-code' });
        if (++badCodes >= MAX_BAD_CODES) ws.close();
        return;
      }
      const result = room.join(msg.name, send);
      if (result.error) {
        send({ type: 'error', reason: result.error });
        return;
      }
      peerId = result.id;
      sockets.set(peerId, ws);
      send({ type: 'joined', id: peerId, peers: result.peers, sharer: result.sharer, sharedFor: result.sharedFor, token: result.token });
      return;
    }

    if (msg.type === 'leave') {
      room.leave(peerId);
    } else if (msg.type === 'signal') {
      room.relay(peerId, msg.to, msg.data);
    } else if (msg.type === 'state') {
      room.setMuted(peerId, msg.muted);
    } else if (msg.type === 'sound') {
      if (soundIds.has(msg.sound)) room.sound(peerId, msg.sound);
    } else if (msg.type === 'share') {
      if (msg.on) {
        if (!room.startShare(peerId)) send({ type: 'share-denied' });
      } else {
        room.stopShare(peerId);
      }
    }
  });

  ws.on('close', (code, reason) => {
    const secs = Math.round((Date.now() - connectedAt) / 1000);
    const extra = (reason.length ? ` (${reason})` : '') + (ws.isAlive ? '' : ', sem pong') + (ws.superseded ? ', substituída' : '');
    log(`ws fechou: pessoa ${peerId ?? '-'} após ${secs}s, código ${code}${extra}`);
    if (peerId === null || ws.superseded || sockets.get(peerId) !== ws) return;
    sockets.delete(peerId);
    room.detach(peerId); // segura a vaga: o cliente pode retomar com o token
  });
  ws.on('error', () => ws.terminate());
});

function printAccess(base) {
  console.log('\n  Código da sala: ' + room.code);
  console.log('  Link para os amigos: ' + base + '/#' + room.code + '\n');
}

function startTunnel() {
  let proc;
  try {
    const args = ['tunnel', '--url', `http://localhost:${PORT}`];
    // TUNNEL_PROTOCOL=http2 troca o QUIC (UDP) por TCP, mais estável em algumas redes domésticas.
    if (process.env.TUNNEL_PROTOCOL) args.push('--protocol', process.env.TUNNEL_PROTOCOL);
    proc = spawn('cloudflared', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    return noTunnel();
  }
  let announced = false;
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    const match = !announced && text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      announced = true;
      printAccess(match[0]);
    }
    for (const line of text.split('\n')) {
      if (/\b(ERR|WRN)\b|retry|disconnect|unable|failed/i.test(line)) log('[cloudflared]', line.trim());
    }
  });
  proc.on('error', (err) => {
    if (err.code === 'ENOENT') noTunnel();
  });
  const stop = () => proc.kill();
  process.on('exit', stop);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

function noTunnel() {
  console.log('\n  cloudflared não encontrado: a sala só está acessível na rede local.');
  console.log('  Instale o cloudflared para gerar um link público (veja o README).');
  printAccess(`http://localhost:${PORT}`);
}

server.listen(PORT, () => {
  console.log(`Discotavo rodando em http://localhost:${PORT}`);
  if (USE_TUNNEL) startTunnel();
  else printAccess(`http://localhost:${PORT}`);
});
