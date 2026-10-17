'use strict';
// File d'attente des changements de rôles des membres :
// - regroupe les rafales (anti-rebond par membre : seul le dernier état compte),
// - envoie les membres UN PAR UN au site (qui calcule et applique les pseudos),
// - une erreur sur un membre n'arrête jamais les suivants.
function createNickQueue(opts) {
  const send = opts.send;
  const debounceMs = opts.debounceMs == null ? 3000 : opts.debounceMs;
  const gapMs = opts.gapMs == null ? 300 : opts.gapMs;
  const log = opts.log || console;
  const pending = new Map(); // id -> { member, timer }
  const ready = [];
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    while (ready.length) {
      const m = ready.shift();
      try { await send(m); } catch (e) { log.error('Pseudo (événement) :', e.message); }
      await new Promise((r) => setTimeout(r, gapMs));
    }
    running = false;
  }
  function push(member) {
    if (!member || !member.id) return;
    const cur = pending.get(member.id);
    if (cur) clearTimeout(cur.timer);
    const timer = setTimeout(() => {
      pending.delete(member.id);
      if (ready.length < 5000) ready.push(member);
      run();
    }, debounceMs);
    pending.set(member.id, { member, timer });
  }
  return { push, size: () => pending.size + ready.length };
}
module.exports = { createNickQueue };
