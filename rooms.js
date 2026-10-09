'use strict';
// Salles de séance écrites en temps réel : chat, quiz plein écran et diapositives (éléments positionnés).
// Tout est en mémoire : si Render redémarre, l'historique du chat d'une séance en cours est perdu
// (les séances, invités et le studio sont dans Google Sheets).
const crypto = require('crypto');

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const color = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(String(v)) ? String(v) : d);
const httpsUrl = (v) => { v = clip(v, 300); return /^https:\/\/\S+$/.test(v) ? v : ''; };
const rid = () => crypto.randomBytes(6).toString('hex');

const num = (v, min, max, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d; };
const FONTS = ['sans', 'serif', 'mono', 'display'];
const KINDS = ['rect', 'ellipse', 'triangle', 'diamond', 'star', 'arrow', 'line'];
function cleanEl(e) {
  if (!e || typeof e !== 'object' || !['text', 'shape', 'image'].includes(e.t)) return null;
  const o = { id: clip(e.id, 20) || rid(), t: e.t, x: num(e.x, -960, 1920, 0), y: num(e.y, -540, 1080, 0),
    w: num(e.w, 4, 2000, 100), h: num(e.h, 2, 1200, 50), rot: num(e.rot, -360, 360, 0), op: num(e.op, 5, 100, 100) };
  if (e.t === 'text') {
    o.text = String(e.text == null ? '' : e.text).slice(0, 2000);
    o.size = num(e.size, 6, 300, 28); o.color = color(e.color, '#eef0fa');
    o.font = FONTS.includes(e.font) ? e.font : 'sans';
    o.b = !!e.b; o.i = !!e.i; o.u = !!e.u;
    o.align = ['l', 'c', 'r'].includes(e.align) ? e.align : 'l';
    o.va = ['t', 'm', 'b'].includes(e.va) ? e.va : 't';
  } else if (e.t === 'shape') {
    o.kind = KINDS.includes(e.kind) ? e.kind : 'rect';
    o.fill = e.fill === '' ? '' : color(e.fill, '#4a7bff');
    o.stroke = color(e.stroke, ''); o.sw = num(e.sw, 0, 40, 0); o.rad = num(e.rad, 0, 300, 0);
  } else {
    o.src = httpsUrl(e.src); o.fit = e.fit === 'cover' ? 'cover' : 'contain'; o.rad = num(e.rad, 0, 300, 0);
  }
  return o;
}
// Anciennes diapos (titre + texte + image) -> éléments
function legacySlide(s) {
  const fg = color(s.fg, '#eef0fa'), title = clip(s.title, 120), text = clip(s.text, 1500), img = httpsUrl(s.img), out = [];
  if (title) out.push({ id: 't1', t: 'text', x: 60, y: 40, w: 840, h: 110, text: title, size: 54, color: fg, font: 'display', b: true, align: 'l', va: 'm' });
  if (text) out.push({ id: 't2', t: 'text', x: 60, y: 170, w: img ? 480 : 840, h: 330, text, size: 28, color: fg });
  if (img) out.push({ id: 'i1', t: 'image', x: 580, y: 170, w: 320, h: 330, src: img, fit: 'contain' });
  return out.map(cleanEl).filter(Boolean);
}
function cleanSlide(s) {
  s = s || {};
  const elements = Array.isArray(s.elements) ? s.elements.slice(0, 60).map(cleanEl).filter(Boolean) : legacySlide(s);
  return { bg: color(s.bg, '#141937'), bg2: s.bg2 ? color(s.bg2, '') : '', elements };
}
function cleanQuiz(q) {
  q = q || {};
  const kind = q.kind === 'text' ? 'text' : 'qcm';
  const question = clip(q.q, 300);
  if (!question) return null;
  const time = Math.round(num(q.time, 0, 300, 0));
  if (kind === 'text') return { kind, q: question, options: [], multi: false, correct: [], time };
  const options = (Array.isArray(q.options) ? q.options : []).map((o) => clip(o, 120)).filter(Boolean).slice(0, 6);
  if (options.length < 2) return null;
  const correct = [...new Set((Array.isArray(q.correct) ? q.correct : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < options.length))];
  return { kind, q: question, options, multi: !!q.multi, correct, time };
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

class Room {
  constructor(sid, name) {
    this.sid = sid; this.name = name;
    this.clients = new Map(); // uid -> client
    this.chat = []; this.slide = null; this.q = null; this.scores = new Map();
    this.emptyAt = Date.now(); this.ended = false;
  }
  pub(c) { return { id: c.uid, name: c.name, role: c.role }; }
  broadcast(obj, exceptUid) { for (const c of this.clients.values()) if (c.uid !== exceptUid) c.send(obj); }
  pushChat(msg) { this.chat.push(msg); if (this.chat.length > 300) this.chat.shift(); this.broadcast({ t: 'chat', msg }); }

  pubQuiz(q) { return { id: q.id, kind: q.spec.kind, q: q.spec.q, options: q.spec.options, multi: q.spec.multi, time: q.spec.time }; }
  counts(q) {
    const counts = q.spec.options.map(() => 0);
    if (q.spec.kind === 'qcm') for (const r of q.answers.values()) r.a.forEach((i) => { counts[i]++; });
    return counts;
  }
  resultFor(q, c) {
    const texts = [];
    if (q.spec.kind === 'text') for (const r of q.answers.values()) texts.push(c.role === 'host' ? { name: r.name, a: r.a } : { a: r.a });
    const mine = q.answers.get(c.uid);
    const you = mine ? { answer: mine.a, ok: q.spec.kind === 'qcm' && q.spec.correct.length ? sameSet(mine.a, q.spec.correct) : null } : null;
    const board = [...this.scores.values()].sort((a, b) => b.pts - a.pts).slice(0, 5).map((x) => ({ name: x.name, pts: x.pts }));
    const my = this.scores.get(c.uid);
    return { t: 'quiz.result', id: q.id, counts: this.counts(q), correct: q.spec.correct, total: q.answers.size, you, texts, board, pts: my ? my.pts : 0 };
  }
  openQuiz(spec) {
    this.closeQuiz(true);
    const q = { id: rid(), spec, open: true, answers: new Map(), endsAt: spec.time ? Date.now() + spec.time * 1000 : 0, timer: null };
    this.q = q;
    if (spec.time) q.timer = setTimeout(() => this.closeQuiz(), spec.time * 1000 + 100);
    this.broadcast({ t: 'quiz.open', quiz: this.pubQuiz(q), left: spec.time ? spec.time * 1000 : 0 });
  }
  closeQuiz(silent) {
    const q = this.q;
    if (!q || !q.open) return;
    q.open = false; clearTimeout(q.timer);
    if (q.spec.kind === 'qcm' && q.spec.correct.length) {
      for (const [uid, r] of q.answers) {
        if (!sameSet(r.a, q.spec.correct)) continue;
        const s = this.scores.get(uid) || { name: r.name, pts: 0 };
        s.name = r.name; s.pts += 1; this.scores.set(uid, s);
      }
    }
    if (!silent) for (const c of this.clients.values()) c.send(this.resultFor(q, c));
  }
  hideQuiz() { if (this.q) clearTimeout(this.q.timer); this.q = null; this.broadcast({ t: 'quiz.hide' }); }

  add(client) {
    if (this.ended) { client.send({ t: 'end' }); client.close(); return; }
    const old = this.clients.get(client.uid);
    if (old) { old.send({ t: 'replaced' }); this.clients.delete(client.uid); old.close(); this.broadcast({ t: 'peer.leave', id: client.uid }); }
    this.clients.set(client.uid, client);
    let quiz = null;
    if (this.q) {
      const q = this.q;
      quiz = { phase: q.open ? 'open' : 'result', quiz: this.pubQuiz(q), left: q.open && q.endsAt ? Math.max(0, q.endsAt - Date.now()) : 0,
        answered: q.answers.has(client.uid), count: q.answers.size, counts: client.role === 'host' ? this.counts(q) : null,
        result: q.open ? null : this.resultFor(q, client) };
    }
    client.send({ t: 'hello', you: this.pub(client), name: this.name,
      peers: [...this.clients.values()].filter((c) => c.uid !== client.uid).map((c) => this.pub(c)),
      chat: this.chat.slice(-100), slide: this.slide, quiz });
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
        this.openQuiz(spec);
        return;
      }
      case 'quiz.answer': {
        if (host) return;
        const q = this.q;
        if (!q || !q.open || q.id !== String(m.id)) return;
        if (q.endsAt && Date.now() > q.endsAt + 300) return; // trop tard
        let a;
        if (q.spec.kind === 'text') { a = clip(m.answer, 300); if (!a) return; }
        else {
          a = [...new Set((Array.isArray(m.answer) ? m.answer : [m.answer]).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < q.spec.options.length))];
          if (!q.spec.multi) a = a.slice(0, 1);
          if (!a.length) return;
        }
        q.answers.set(client.uid, { name: client.name, a });
        for (const c of this.clients.values()) if (c.role === 'host') c.send({ t: 'quiz.progress', id: q.id, count: q.answers.size, counts: this.counts(q) });
        return;
      }
      case 'quiz.close': if (host) this.closeQuiz(); return;
      case 'quiz.hide': if (host) this.hideQuiz(); return;
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
      case 'end':
        if (!host) return;
        this.ended = true;
        if (this.q) clearTimeout(this.q.timer);
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
        if (d.length > 100000) return;
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
              
