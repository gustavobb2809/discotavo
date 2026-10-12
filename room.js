'use strict';

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_PEERS = 8;
const MAX_NAME = 24;
const GRACE_MS = 30000;
const MAX_QUEUED = 200;
const SOUND_COOLDOWN_MS = 400;

function generateCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out.slice(0, 4) + '-' + out.slice(4);
}

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function cleanName(value) {
  const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return name || 'Anônimo';
}

class Room {
  constructor(code = generateCode(), max = MAX_PEERS, graceMs = GRACE_MS) {
    this.code = code;
    this.max = max;
    this.graceMs = graceMs;
    this.peers = new Map();
    this.nextId = 1;
    this.sharerId = null;
    this.sharedAt = 0;
  }

  // Há quantos ms a tela está sendo compartilhada (null se ninguém compartilha).
  sharedFor() {
    return this.sharerId === null ? null : Date.now() - this.sharedAt;
  }

  checkCode(value) {
    const a = Buffer.from(normalizeCode(value));
    const b = Buffer.from(normalizeCode(this.code));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // send(msg) entrega um objeto ao cliente; devolve { id, peers } ou { error }.
  join(name, send) {
    if (this.peers.size >= this.max) return { error: 'full' };
    const id = String(this.nextId++);
    const token = crypto.randomBytes(16).toString('hex');
    const peer = { id, token, name: cleanName(name), muted: false, send, timer: null, queue: null };
    const others = this.list();
    this.peers.set(id, peer);
    this.broadcast({ type: 'peer-joined', peer: publicPeer(peer) }, id);
    return { id, token, peers: others, sharer: this.sharerId, sharedFor: this.sharedFor() };
  }

  // A conexão caiu: segura a vaga por graceMs e guarda só a sinalização, que não dá para reconstruir.
  detach(id) {
    const peer = this.peers.get(id);
    if (!peer || peer.queue) return;
    peer.queue = [];
    peer.send = (msg) => {
      if (msg.type === 'signal' && peer.queue.length < MAX_QUEUED) peer.queue.push(msg);
    };
    peer.timer = setTimeout(() => this.leave(id), this.graceMs);
    if (peer.timer.unref) peer.timer.unref();
  }

  // Devolve o estado atual da sala e a sinalização perdida, ou null se o token não vale mais.
  resume(token, send) {
    for (const peer of this.peers.values()) {
      if (typeof token !== 'string' || peer.token.length !== token.length) continue;
      if (!crypto.timingSafeEqual(Buffer.from(peer.token), Buffer.from(token))) continue;
      clearTimeout(peer.timer);
      peer.timer = null;
      const queued = peer.queue || [];
      peer.queue = null;
      peer.send = send;
      return {
        id: peer.id,
        peers: this.list().filter((p) => p.id !== peer.id),
        sharer: this.sharerId,
        sharedFor: this.sharedFor(),
        queued,
      };
    }
    return null;
  }

  leave(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    clearTimeout(peer.timer);
    this.peers.delete(id);
    const wasSharing = this.sharerId === id;
    if (wasSharing) this.sharerId = null;
    this.broadcast({ type: 'peer-left', id });
    if (wasSharing) this.broadcast({ type: 'share', id: null });
  }

  // Só uma pessoa compartilha a tela por vez; devolve false se a vez é de outra.
  startShare(id) {
    if (!this.peers.has(id)) return false;
    if (this.sharerId !== null && this.sharerId !== id) return false;
    if (this.sharerId !== id) this.sharedAt = Date.now();
    this.sharerId = id;
    this.broadcast({ type: 'share', id }, id);
    return true;
  }

  stopShare(id) {
    if (this.sharerId !== id) return;
    this.sharerId = null;
    this.broadcast({ type: 'share', id: null }, id);
  }

  setMuted(id, muted) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.muted = Boolean(muted);
    this.broadcast({ type: 'peer-state', id, muted: peer.muted }, id);
  }

  // Toca um som para os outros; o limite por pessoa evita flood. Devolve false se barrado.
  sound(id, soundId) {
    const peer = this.peers.get(id);
    if (!peer || typeof soundId !== 'string') return false;
    const now = Date.now();
    if (now - (peer.lastSound || 0) < SOUND_COOLDOWN_MS) return false;
    peer.lastSound = now;
    this.broadcast({ type: 'sound', id, sound: soundId }, id);
    return true;
  }

  relay(from, to, data) {
    const target = this.peers.get(String(to));
    if (!target || !this.peers.has(from) || from === target.id) return false;
    target.send({ type: 'signal', from, data });
    return true;
  }

  list() {
    return [...this.peers.values()].map(publicPeer);
  }

  get size() {
    return this.peers.size;
  }

  broadcast(msg, exceptId) {
    for (const peer of this.peers.values()) {
      if (peer.id !== exceptId) peer.send(msg);
    }
  }
}

function publicPeer(p) {
  return { id: p.id, name: p.name, muted: p.muted };
}

module.exports = { Room, generateCode, normalizeCode, cleanName, MAX_PEERS };
