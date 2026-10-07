'use strict';
// Salles de séance écrites en temps réel : chat, quiz et diapositives.
// Tout est en mémoire : si Render redémarre, l'historique du chat d'une séance en cours est perdu
// (les séances, invités et le studio sont dans Google Sheets).
const crypto = require('crypto');

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const color = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : d);
const httpsUrl = (v) => { v = clip(v, 300); return /^https:\/\/\S+$/.test(v) ? v : ''; };
const rid = () => crypto.randomBytes(6).toString('hex');

function cleanSlide(s) {
  s = s || {};
  return { title: clip(s.title, 120), text: clip(s.text, 1500), img: httpsUrl(s.img), bg: color(s.bg, '#141937'), fg: color(s.fg, '#eef0fa') };
}
function cleanQuiz(q) {
  q = q || {};
  const kind = q.kind === 'text' ? 'text' : 'qcm';
  const question = clip(q.q, 300);
  if (!question) return null;
  if (kind === 'text') return { kind, q: question, options: [], multi: false, correct: [] };
  const options = (Array.isArray(q.options) ? q.options : []).map((o) => clip(o, 120)).filter(Boolean).slice(0, 8);
  if (options.length < 2) return null;
  const correct = [...new Set((Array.isArray(q.correct) ? q.correct : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < options.length))];
  return { kind, q: question, options, multi: !!q.multi, correct };
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

class Room {
  constructor(sid, name) {
    this.sid = sid; this.name = name;
    this.clients = new Map(); // uid -> client
    this.chat = []; this.slide = null; this.quizzes = new Map();
    this.emptyAt = Date.now(); this.ended = false;
  }
  pub(c) { return { id: c.uid, name: c.name, role: c.role }; }
  broadcast(obj, exceptUid) { for (const c of this.clients.values()) if (c.uid !== exceptUid) c.send(obj); }
  pushChat(msg) { this.chat.push(msg); if (this.chat.length > 300) this.chat.shift(); this.broadcast({ t: 'chat', msg }); }

  resultFor(qz, c) {
    const counts = qz.spec.options.map(() => 0), texts = [];
    for (const [uid, r] of qz.answers) {
      if (qz.spec.kind === 'qcm') r.a.forEach((i) => { counts[i]++; });
      else texts.push({ name: r.name, a: r.a, uid });
    }
    const mine = qz.answers.get(c.uid);
    const you = mine ? { answer: mine.a, ok: qz.spec.kind === 'qcm' && qz.spec.correct.length ? sameSet(mine.a, qz.spec.correct) : null } : null;
    return { t: 'quiz.result', id: qz.id, counts, correct: qz.spec.correct, total: qz.answers.size, you,
      texts: texts.map((x) => (c.role === 'host' ? { name: x.name, a: x.a } : { a: x.a })) };
  }

  add(client) {
    if (this.ended) { client.send({ t: 'end' }); client.close(); return; }
    const old = this.clients.get(client.uid);
    if (old) { old.send({ t: 'replaced' }); this.clients.delete(client.uid); old.close(); this.broadcast({ t: 'peer.leave', id: client.uid }); }
    this.clients.set(client.uid, client);
    const closed = [], answered = [], progress = [];
    for (const qz of this.quizzes.values()) {
      if (!qz.open) closed.push(this.resultFor(qz, client));
      else { if (qz.answers.has(client.uid)) answered.push(qz.id); progress.push({ id: qz.id, count: qz.answers.size }); }
    }
    client.send({ t: 'hello', you: this.pub(client), name: this.name,
      peers: [...this.clients.values()].filter((c) => c.uid !== client.uid).map((c) => this.pub(c)),
      chat: this.chat.slice(-100), slide: this.slide, closed, answered, progress: client.role === 'host' ? progress : [] });
    this.broadcast({ t: 'peer.join', peer: this.pub(client) }, client.uid);
  }
  remove(client) {
    if (this.clients.get(client.uid) === client) { this.clients.delete(client.uid); this.broadcast({ t: 'peer.leave', id: client.uid }); }
    if (!this.clients.size) this.emptyAt = Date.now();
  }

  handle(client, m) {
    if (!m || typeof m !== 'object' || this.ended) return;
    const host = client.role === 'host';
    switch (m.t) {
      case 'chat': {
        const text = clip(m.text, 1000);
        if (!text) return;
        const now = Date.now();
        client.chatTimes = (client.chatTimes || []).filter((x) => now - x < 5000);
        if (client.chatTimes.length >= 6) return; // anti-spam
        client.chatTimes.push(now);
        this.pushChat({ id: rid(), uid: client.uid, name: client.name, kind: 'text', text, ts: now });
        return;
      }
      case 'quiz.send': {
        if (!host) return;
        const spec = cleanQuiz(m.quiz);
        if (!spec) { client.send({ t: 'error', msg: 'Quiz invalide.' }); return; }
        const id = rid();
        this.quizzes.set(id, { id, spec, open: true, answers: new Map() });
        this.pushChat({ id: rid(), uid: client.uid, name: client.name, kind: 'quiz', ts: Date.now(),
          payload: { id, kind: spec.kind, q: spec.q, options: spec.options, multi: spec.multi } });
        client.send({ t: 'quiz.host', id, correct: spec.correct });
        return;
      }
      case 'quiz.answer': {
        if (host) return;
        const qz = this.quizzes.get(String(m.id));
        if (!qz || !qz.open) return;
        let a;
        if (qz.spec.kind === 'text') { a = clip(m.answer, 300); if (!a) return; }
        else {
          a = [...new Set((Array.isArray(m.answer) ? m.answer : [m.answer]).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < qz.spec.options.length))];
          if (!qz.spec.multi) a = a.slice(0, 1);
          if (!a.length) return;
        }
        qz.answers.set(client.uid, { name: client.name, a });
        for (const c of this.clients.values()) if (c.role === 'host') c.send({ t: 'quiz.progress', id: qz.id, count: qz.answers.size });
        return;
      }
      case 'quiz.close': {
        if (!host) return;
        const qz = this.quizzes.get(String(m.id));
        if (!qz || !qz.open) return;
        qz.open = false;
        for (const c of this.clients.values()) c.send(this.resultFor(qz, c));
        return;
      }
      case 'slide.show': {
        if (!host) return;
        const index = Math.max(0, parseInt(m.index, 10) || 0), total = Math.max(1, parseInt(m.total, 10) || 1);
        this.slide = { slide: cleanSlide(m.slide), index, total };
        this.broadcast({ t: 'slide', ...this.slide });
        return;
      }
      case 'slide.hide':
        if (!host) return;
        this.slide = null;
        this.broadcast({ t: 'slide', slide: null });
        return;
      case 'slide.send':
        if (!host) return;
        this.pushChat({ id: rid(), uid: client.uid, name: client.name, kind: 'slide', ts: Date.now(), payload: cleanSlide(m.slide) });
        return;
      case 'end':
        if (!host) return;
        this.ended = true;
        this.broadcast({ t: 'end' });
        for (const c of [...this.clients.values()]) c.close();
        return;
      default:
    }
  }
}

// Le "ticket" est signé par le site Google (HMAC avec API_KEY) : personne ne peut entrer sans y avoir droit.
function verifyTicket(t, key) {
  if (!t || !key) return null;
  const [p, s] = String(t).split('.');
  if (!p || !s) return null;
  const exp = crypto.createHmac('sha256', key).update(p).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const got = s.replace(/=+$/, '');
  const a = Buffer.from(exp), b = Buffer.from(got);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return o.exp > Date.now() ? o : null;
  } catch (e) { return null; }
}

function attach(server, key) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map();
  server.on('upgrade', (req, socket, head) => {
    let u; try { u = new URL(req.url, 'http://x'); } catch (e) { socket.destroy(); return; }
    if (u.pathname !== '/ws') { socket.destroy(); return; }
    const t = verifyTicket(u.searchParams.get('ticket'), key);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!t) { ws.close(4001, 'ticket'); return; }
      let room = rooms.get(t.sid);
      if (!room) { room = new Room(t.sid, clip(t.sname, 80)); rooms.set(t.sid, room); }
      const client = {
        uid: String(t.uid), name: clip(t.name, 60) || '?', role: t.role === 'host' ? 'host' : 'guest',
        send: (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
        close: () => { try { ws.close(); } catch (e) {} },
      };
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => {});
      ws.on('message', (d) => {
        if (d.length > 30000) return;
        let m; try { m = JSON.parse(d); } catch (e) { return; }
        room.handle(client, m);
      });
      ws.on('close', () => room.remove(client));
      room.add(client);
    });
  });
  setInterval(() => {
    wss.clients.forEach((ws) => { if (ws.isAlive === false) { ws.terminate(); return; } ws.isAlive = false; try { ws.ping(); } catch (e) {} });
    for (const [sid, r] of rooms) if (!r.clients.size && Date.now() - r.emptyAt > 10 * 60 * 1000) rooms.delete(sid);
  }, 30000);
}

module.exports = { Room, verifyTicket, attach, cleanQuiz, cleanSlide };
