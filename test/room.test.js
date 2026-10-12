'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, generateCode, normalizeCode, cleanName } = require('../room');

function client() {
  const inbox = [];
  return { inbox, send: (m) => inbox.push(m) };
}

test('generateCode usa o formato XXXX-XXXX sem caracteres ambíguos', () => {
  for (let i = 0; i < 50; i++) {
    assert.match(generateCode(), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  }
});

test('checkCode ignora caixa e hífen, mas rejeita código errado', () => {
  const room = new Room('K7QM-2XPD');
  assert.ok(room.checkCode('k7qm-2xpd'));
  assert.ok(room.checkCode('K7QM2XPD'));
  assert.ok(!room.checkCode('K7QM-2XPE'));
  assert.ok(!room.checkCode(''));
  assert.ok(!room.checkCode(undefined));
});

test('normalizeCode e cleanName', () => {
  assert.equal(normalizeCode(' ab-12 '), 'AB12');
  assert.equal(cleanName('   '), 'Anônimo');
  assert.equal(cleanName('x'.repeat(100)).length, 24);
});

test('join devolve quem já estava e avisa os outros', () => {
  const room = new Room('AAAA-BBBB');
  const a = client();
  const b = client();
  const ra = room.join('Ana', a.send);
  assert.deepEqual(ra.peers, []);
  const rb = room.join('Bia', b.send);
  assert.deepEqual(rb.peers, [{ id: ra.id, name: 'Ana', muted: false }]);
  assert.deepEqual(a.inbox, [{ type: 'peer-joined', peer: { id: rb.id, name: 'Bia', muted: false } }]);
  assert.deepEqual(b.inbox, []);
});

test('sala cheia recusa a nona pessoa', () => {
  const room = new Room('AAAA-BBBB', 8);
  for (let i = 0; i < 8; i++) assert.ok(!room.join('p' + i, () => {}).error);
  assert.deepEqual(room.join('extra', () => {}), { error: 'full' });
  assert.equal(room.size, 8);
});

test('leave avisa os outros e libera a vaga', () => {
  const room = new Room('AAAA-BBBB', 1);
  const a = client();
  const { id } = room.join('Ana', a.send);
  room.leave(id);
  assert.equal(room.size, 0);
  assert.ok(!room.join('Bia', () => {}).error);
  room.leave('inexistente');
});

test('relay entrega só ao destinatário e ignora destinos inválidos', () => {
  const room = new Room('AAAA-BBBB');
  const a = client();
  const b = client();
  const c = client();
  const ra = room.join('Ana', a.send);
  const rb = room.join('Bia', b.send);
  room.join('Cai', c.send);
  a.inbox.length = b.inbox.length = c.inbox.length = 0;

  assert.ok(room.relay(ra.id, rb.id, { sdp: 'x' }));
  assert.deepEqual(b.inbox, [{ type: 'signal', from: ra.id, data: { sdp: 'x' } }]);
  assert.equal(c.inbox.length, 0);
  assert.ok(!room.relay(ra.id, '999', {}));
  assert.ok(!room.relay(ra.id, ra.id, {}));
  assert.ok(!room.relay('999', rb.id, {}));
});

test('setMuted notifica os outros e guarda o estado', () => {
  const room = new Room('AAAA-BBBB');
  const a = client();
  const b = client();
  const ra = room.join('Ana', a.send);
  room.join('Bia', b.send);
  b.inbox.length = 0;
  room.setMuted(ra.id, true);
  assert.deepEqual(b.inbox, [{ type: 'peer-state', id: ra.id, muted: true }]);
  assert.equal(room.list()[0].muted, true);
});

test('só uma pessoa compartilha a tela por vez', () => {
  const room = new Room('AAAA-BBBB');
  const a = client();
  const b = client();
  const ra = room.join('Ana', a.send);
  const rb = room.join('Bia', b.send);
  a.inbox.length = b.inbox.length = 0;

  assert.ok(room.startShare(ra.id));
  assert.deepEqual(b.inbox, [{ type: 'share', id: ra.id }]);
  assert.equal(a.inbox.length, 0);
  assert.ok(!room.startShare(rb.id));
  assert.ok(room.startShare(ra.id));

  room.stopShare(rb.id); // quem não compartilha não consegue parar
  assert.equal(room.sharerId, ra.id);

  b.inbox.length = 0;
  room.stopShare(ra.id);
  assert.deepEqual(b.inbox, [{ type: 'share', id: null }]);
  assert.ok(room.startShare(rb.id));
});

test('quem entra depois sabe quem está compartilhando', () => {
  const room = new Room('AAAA-BBBB');
  const ra = room.join('Ana', () => {});
  room.startShare(ra.id);
  assert.equal(room.join('Bia', () => {}).sharer, ra.id);
});

test('se quem compartilha sai, a vez é liberada e os outros são avisados', () => {
  const room = new Room('AAAA-BBBB');
  const b = client();
  const ra = room.join('Ana', () => {});
  room.join('Bia', b.send);
  room.startShare(ra.id);
  b.inbox.length = 0;
  room.leave(ra.id);
  assert.deepEqual(b.inbox, [{ type: 'peer-left', id: ra.id }, { type: 'share', id: null }]);
  assert.equal(room.sharerId, null);
});

test('id inexistente não consegue compartilhar', () => {
  assert.ok(!new Room('AAAA-BBBB').startShare('999'));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('detach segura a vaga e retém só a sinalização até a retomada', () => {
  const room = new Room('AAAA-BBBB', 8, 1000);
  const a = client();
  const b = client();
  const ra = room.join('Ana', a.send);
  const rb = room.join('Bia', b.send);
  a.inbox.length = b.inbox.length = 0;

  room.detach(ra.id);
  room.setMuted(rb.id, true);
  room.relay(rb.id, ra.id, { description: { type: 'offer' } });
  assert.deepEqual(a.inbox, []);
  assert.equal(room.size, 2);

  const fresh = client();
  const resumed = room.resume(ra.token, fresh.send);
  assert.equal(resumed.id, ra.id);
  assert.deepEqual(resumed.peers, [{ id: rb.id, name: 'Bia', muted: true }]);
  assert.deepEqual(resumed.queued, [{ type: 'signal', from: rb.id, data: { description: { type: 'offer' } } }]);

  room.relay(rb.id, ra.id, { candidate: 'x' });
  assert.equal(fresh.inbox.length, 1);
  room.leave(ra.id);
});

test('passado o prazo sem retomar, a pessoa sai e os outros são avisados', async () => {
  const room = new Room('AAAA-BBBB', 8, 20);
  const b = client();
  const ra = room.join('Ana', () => {});
  room.join('Bia', b.send);
  b.inbox.length = 0;
  room.detach(ra.id);
  await sleep(60);
  assert.equal(room.size, 1);
  assert.deepEqual(b.inbox, [{ type: 'peer-left', id: ra.id }]);
  assert.equal(room.resume(ra.token, () => {}), null);
});

test('resume rejeita token errado, vazio ou de pessoa que já saiu', () => {
  const room = new Room('AAAA-BBBB');
  const ra = room.join('Ana', () => {});
  assert.equal(room.resume('x'.repeat(32), () => {}), null);
  assert.equal(room.resume('', () => {}), null);
  assert.equal(room.resume(undefined, () => {}), null);
  room.leave(ra.id);
  assert.equal(room.resume(ra.token, () => {}), null);
});

test('resume cancela o prazo: a pessoa não sai depois', async () => {
  const room = new Room('AAAA-BBBB', 8, 20);
  const ra = room.join('Ana', () => {});
  room.detach(ra.id);
  room.resume(ra.token, () => {});
  await sleep(60);
  assert.equal(room.size, 1);
  room.leave(ra.id);
});

test('quem sai de propósito não deixa prazo pendente', async () => {
  const room = new Room('AAAA-BBBB', 8, 20);
  const ra = room.join('Ana', () => {});
  room.detach(ra.id);
  room.leave(ra.id);
  room.detach(ra.id); // pessoa inexistente: ignorado
  await sleep(60);
  assert.equal(room.size, 0);
});

test('sharedFor informa há quanto tempo a tela é compartilhada', async () => {
  const room = new Room('AAAA-BBBB');
  const ra = room.join('Ana', () => {});
  assert.equal(room.sharedFor(), null);
  assert.equal(room.join('Bia', () => {}).sharedFor, null);
  room.startShare(ra.id);
  await sleep(30);
  room.startShare(ra.id); // repetir não reinicia o relógio
  const late = room.join('Cai', () => {});
  assert.ok(late.sharedFor >= 25 && late.sharedFor < 1000, String(late.sharedFor));
  room.stopShare(ra.id);
  assert.equal(room.sharedFor(), null);
});

test('sound avisa os outros, não quem tocou, e respeita o intervalo mínimo', async () => {
  const room = new Room('AAAA-BBBB');
  const a = client();
  const b = client();
  const ra = room.join('Ana', a.send);
  room.join('Bia', b.send);
  a.inbox.length = b.inbox.length = 0;
  assert.ok(room.sound(ra.id, 'ding'));
  assert.deepEqual(b.inbox, [{ type: 'sound', id: ra.id, sound: 'ding' }]);
  assert.equal(a.inbox.length, 0);
  assert.equal(room.sound(ra.id, 'ding'), false); // dentro do intervalo
  await sleep(450);
  assert.ok(room.sound(ra.id, 'ding'));
  assert.equal(room.sound('999', 'ding'), false);
  assert.equal(room.sound(ra.id, 42), false);
});
