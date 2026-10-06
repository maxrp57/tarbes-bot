
// Garde le bot Tarbes RP en ligne ET fait passer les actions de la page Admin vers Discord.
// Variables Render : BOT_TOKEN (jeton du bot) et API_KEY (mot de passe partagé avec Google).
const http = require('http');
const crypto = require('crypto');
const { Client, GatewayIntentBits, ActivityType, EmbedBuilder } = require('discord.js');

const token = (process.env.BOT_TOKEN || '').trim().replace(/^["']|["']$/g, '').replace(/^Bot\s+/i, '');
const API_KEY = (process.env.API_KEY || '').trim();
console.log('Longueur du jeton :', token.length, '| points :', (token.match(/\./g) || []).length, '(attendu : environ 70 et 2)');
console.log('API_KEY définie :', API_KEY.length > 0);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => {
  client.user.setPresence({ status: 'online', activities: [{ name: 'Tarbes RP', type: ActivityType.Playing }] });
  console.log('Bot en ligne :', client.user.tag);
});
// ---- Giveaways : boutons "Je participe" / "Je ne participe pas" ----
// Les participants sont enregistrés dans la feuille Google (via SITE_URL), pas ici : rien n'est perdu si Render redémarre.
const SITE_URL = (process.env.SITE_URL || '').trim();
console.log('SITE_URL définie :', SITE_URL.length > 0);
async function site(payload) {
  if (!SITE_URL) throw new Error('SITE_URL manquant sur Render.');
  const r = await fetch(SITE_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, redirect: 'follow',
    body: JSON.stringify({ key: API_KEY, ...payload }), signal: AbortSignal.timeout(25000),
  });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error('Réponse inattendue de Google (HTTP ' + r.status + ') : ' + text.replace(/\s+/g, ' ').slice(0, 160)); }
}
const pendingCount = new Map();
function scheduleCount(message) { // le site redessine le message avec le nouveau nombre (au plus toutes les ~4 s)
  if (pendingCount.has(message.id)) return;
  pendingCount.set(message.id, setTimeout(async () => {
    pendingCount.delete(message.id);
    try { await site({ action: 'gwRefresh', msgId: message.id }); }
    catch (err) { console.error('Compteur non mis à jour :', err.message); }
  }, 4000));
}
client.on('interactionCreate', async (i) => {
  if (!i.isButton() || !['gw:join', 'gw:leave'].includes(i.customId)) return;
  try {
    await i.deferReply({ flags: 64 }); // réponse visible seulement par la personne
    const roles = i.member && i.member.roles && i.member.roles.cache ? [...i.member.roles.cache.keys()] : [];
    const r = await site({
      action: i.customId === 'gw:join' ? 'gwJoin' : 'gwLeave', msgId: i.message.id, userId: i.user.id,
      name: (i.member && i.member.displayName) || i.user.username, roles,
    });
    await i.editReply({ content: r.msg || 'Erreur.' });
    if (r.ok && typeof r.count === 'number') scheduleCount(i.message);
  } catch (e) {
    console.error('Bouton giveaway :', e.message);
    try { await i.editReply({ content: 'Une erreur est survenue, réessaie dans un instant.' }); } catch (x) {}
  }
});
// Toutes les minutes : le site termine les giveaways arrivés à échéance.
function tick() { if (SITE_URL) site({ action: 'gwTick' }).catch((e) => console.error('Tick giveaway :', e.message)); }
setInterval(tick, 60000);
setTimeout(tick, 15000);

client.login(token).catch((e) => console.error('Connexion refusée par Discord :', e.message));

// Seules ces actions sont autorisées (rien d'autre ne peut passer, même avec le mot de passe).
const ALLOWED = [
  ['GET', /^\/users\/@me\/guilds$/],
  ['GET', /^\/guilds\/\d+\/channels$/],
  ['GET', /^\/guilds\/\d+\/members\?limit=\d+&after=\d+$/],
  ['GET', /^\/guilds\/\d+\/members\/\d+$/],
  ['POST', /^\/channels\/\d+\/messages$/],
  ['POST', /^\/users\/@me\/channels$/],
  ['DELETE', /^\/users\/@me\/guilds\/\d+$/],
  ['PATCH', /^\/channels\/\d+\/messages\/\d+$/],
];
const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function discord(method, path, payload) {
  let r, t;
  for (let i = 0; i < 3; i++) {
    const headers = { Authorization: 'Bot ' + token, 'User-Agent': 'DiscordBot (https://tarbes-rp.example, 1.0)' };
    if (payload) headers['Content-Type'] = 'application/json'; // seulement s'il y a un corps à envoyer
    r = await fetch('https://discord.com/api/v10' + path, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    t = await r.text();
    if (r.status === 429) { let w = 1; try { w = JSON.parse(t).retry_after || 1; } catch (e) {} await new Promise((o) => setTimeout(o, Math.min(w, 5) * 1000 + 200)); continue; }
    if (method !== 'POST' && r.status >= 500) { await new Promise((o) => setTimeout(o, 700 * (i + 1))); continue; }
    break;
  }
  return { status: r.status, body: t };
}

// Envoie un MP à chaque personne, doucement (pour respecter les limites de Discord).
async function dmAll(ids, text) {
  for (const id of ids) {
    try {
      const ch = JSON.parse((await discord('POST', '/users/@me/channels', { recipient_id: id })).body);
      if (ch.id) await discord('POST', '/channels/' + ch.id + '/messages', { content: text, allowed_mentions: { parse: [] } });
    } catch (e) { console.error('MP échoué', id, e.message); }
    await new Promise((o) => setTimeout(o, 500));
  }
}
// Liste des membres qui ont un rôle (demande "Server Members Intent" activé sur le portail Discord).
async function roleMembers(guildId, roleId) {
  const out = []; let after = '0';
  for (let i = 0; i < 10; i++) {
    const r = await discord('GET', '/guilds/' + guildId + '/members?limit=1000&after=' + after);
    if (r.status !== 200) { console.error('Liste des membres impossible (', r.status, ') :', String(r.body).slice(0, 120)); break; }
    const page = JSON.parse(r.body);
    page.forEach((m) => { if (m.user && !m.user.bot && (m.roles || []).includes(roleId)) out.push(m.user.id); });
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return out;
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/notify') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body); } catch (e) { return send(res, 400, { message: 'JSON invalide.' }); }
      if (!API_KEY || !same(b.key || '', API_KEY)) return send(res, 403, { message: 'Accès refusé (API_KEY).' });
      const isId = (x) => /^\d{5,25}$/.test(String(x));
      const clean = (v, n) => String(v || '').replace(/[*_`~|>@\\]/g, '').trim().slice(0, n);
      if (b.kind === 'giveaway') { // MP à tous les membres d'un rôle : qui a gagné
        const winners = (Array.isArray(b.winners) ? b.winners : []).map(String).filter(isId).slice(0, 20);
        if (!isId(b.guildId) || !isId(b.roleId) || !winners.length) return send(res, 400, { message: 'Paramètres invalides.' });
        const text = (b.reroll ? '🔁 **Nouveau tirage**' : '🏆 **Giveaway terminé**') + '\nRécompense : **' + clean(b.prize, 100) + '**\nGagnant' + (winners.length > 1 ? 's' : '') + ' : ' +
          winners.map((id) => '<@' + id + '>').join(', ') + '\n\n🎫 Si le gagnant ouvre un ticket, il faut lui donner la récompense.';
        send(res, 202, { ok: true });
        roleMembers(String(b.guildId), String(b.roleId)).then((ids) => dmAll(ids, text)).catch((e) => console.error('MP giveaway :', e.message));
        return;
      }
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter(isId).slice(0, 50);
      const text = '📝 **Nouvelle candidature déposée**\nRecrutement : **' + clean(b.title, 80) + '**\nCandidat : ' + clean(b.user, 60) + '\nVa sur le site Tarbes RP, page Admin, pour voter.';
      send(res, 202, { ok: true, count: ids.length }); // on répond tout de suite, les MP partent ensuite
      dmAll(ids, text);
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const b = JSON.parse(body);
        if (!API_KEY || !same(b.key || '', API_KEY)) return send(res, 403, { message: 'Accès refusé (API_KEY).' });
        const m = String(b.method || '').toUpperCase(), p = String(b.path || '');
        if (!ALLOWED.some((a) => a[0] === m && a[1].test(p))) return send(res, 400, { message: 'Action non autorisée.' });
        send(res, 200, await discord(m, p, b.payload));
      } catch (e) { send(res, 500, { message: String(e.message) }); }
    });
    return;
  }
  res.end('ok'); // page pour le cron
}).listen(process.env.PORT || 3000);
