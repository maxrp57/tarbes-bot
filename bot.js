// Garde le bot Tarbes RP en ligne ET fait passer les actions de la page Admin vers Discord.
// Variables Render : BOT_TOKEN (jeton du bot) et API_KEY (mot de passe partagé avec Google).
const http = require('http');
const crypto = require('crypto');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');

const token = (process.env.BOT_TOKEN || '').trim().replace(/^["']|["']$/g, '').replace(/^Bot\s+/i, '');
const API_KEY = (process.env.API_KEY || '').trim();
console.log('Longueur du jeton :', token.length, '| points :', (token.match(/\./g) || []).length, '(attendu : environ 70 et 2)');
console.log('API_KEY définie :', API_KEY.length > 0);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => {
  client.user.setPresence({ status: 'online', activities: [{ name: 'Tarbes RP', type: ActivityType.Playing }] });
  console.log('Bot en ligne :', client.user.tag);
});
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

http.createServer((req, res) => {
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
