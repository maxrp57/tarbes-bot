// ===== Tarbes RP : tout dans Google Apps Script =====
// Les SECRETS ne vont PAS ici : ils se mettent dans Paramètres du projet > Propriétés du script.
var CLIENT_ID = '1551173253693702265';
var GUILD_ID = '1509580529958129794';
var ADMIN_IDS = ['1509785247892639804'];

function prop(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function sign(s) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, prop('SESSION_SECRET'))); }
function mk(o) {
  var p = Utilities.base64EncodeWebSafe(Utilities.newBlob(JSON.stringify(o)).getBytes());
  return p + '.' + sign(p);
}
function rd(t) {
  if (!t) return null;
  var a = String(t).split('.');
  if (a.length !== 2 || sign(a[0]) !== a[1]) return null;
  try {
    var o = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(a[0])).getDataAsString());
    return o.exp > Date.now() ? o : null;
  } catch (e) { return null; }
}
function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }

// ---- Appels à Discord : bonne identité + nouvelles tentatives ----
function dfetch(url, opts) {
  opts = opts || {};
  opts.muteHttpExceptions = true;
  opts.headers = opts.headers || {};
  opts.headers['User-Agent'] = 'DiscordBot (https://tarbes-rp.example, 1.0)';
  var post = String(opts.method || 'get').toLowerCase() === 'post';
  var r;
  for (var i = 0; i < 4; i++) {
    r = UrlFetchApp.fetch(url, opts);
    var c = r.getResponseCode();
    if (c === 429) {
      var ra = 1;
      try { ra = JSON.parse(r.getContentText()).retry_after || 1; } catch (e) {}
      Utilities.sleep(Math.min(ra, 5) * 1000 + 200);
      continue;
    }
    if (!post && (c >= 500 || (c >= 400 && /internal network error/i.test(r.getContentText())))) {
      Utilities.sleep(700 * (i + 1));
      continue;
    }
    break;
  }
  return r;
}

// ---- Page + retour de Discord ----
function doGet(e) {
  var tok = '';
  var code = e && e.parameter && e.parameter.code;
  if (code) {
    var st = rd(e.parameter.state);
    if (st && st.k === 'state') tok = login(code);
  }
  var t = HtmlService.createTemplateFromFile('index');
  t.tok = tok;
  return t.evaluate().setTitle('Tarbes RP')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function loginUrl() {
  var back = ScriptApp.getService().getUrl();
  return 'https://discord.com/oauth2/authorize?client_id=' + CLIENT_ID + '&response_type=code&prompt=none' +
    '&scope=' + encodeURIComponent('identify guilds') +
    '&redirect_uri=' + encodeURIComponent(back) +
    '&state=' + encodeURIComponent(mk({ k: 'state', exp: Date.now() + 600000 }));
}
function login(code) {
  var r = dfetch('https://discord.com/api/oauth2/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { client_id: CLIENT_ID, client_secret: prop('DISCORD_CLIENT_SECRET'), grant_type: 'authorization_code', code: code, redirect_uri: ScriptApp.getService().getUrl() }
  });
  var j = JSON.parse(r.getContentText());
  if (!j.access_token) return '';
  var h = { headers: { Authorization: 'Bearer ' + j.access_token }, muteHttpExceptions: true };
  var me = JSON.parse(dfetch('https://discord.com/api/users/@me', h).getContentText());
  var gs = JSON.parse(dfetch('https://discord.com/api/users/@me/guilds', h).getContentText());
  var member = Array.isArray(gs) && gs.some(function (g) { return g.id === GUILD_ID; });
  return mk({ id: me.id, name: me.global_name || me.username, member: member, exp: Date.now() + 7 * 24 * 3600 * 1000 });
}

// ---- Feuille Google Sheets ----
function sh(name, header) {
  var ss = SpreadsheetApp.getActive();
  var s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    s.getRange('A:D').setNumberFormat('@');
    s.appendRow(header);
  }
  return s;
}
function list() {
  var s = sh('annonces', ['id', 'titre', 'texte', 'date']);
  return s.getDataRange().getValues().slice(1).map(function (r) {
    return { id: String(r[0]), title: String(r[1]), body: String(r[2]), date: String(r[3]) };
  }).reverse();
}
function getSite() {
  var s = sh('site', ['cle', 'valeur']), o = {};
  s.getDataRange().getValues().slice(1).forEach(function (r) { o[r[0]] = String(r[1]); });
  return o;
}

// ---- Fonctions appelées par le site ----
function getData(tok) {
  var m = rd(tok);
  return {
    me: m ? { name: m.name, member: m.member, isAdmin: ADMIN_IDS.indexOf(m.id) > -1 } : null,
    news: list(), site: getSite(), loginUrl: loginUrl()
  };
}
function adminOnly(tok) {
  var m = rd(tok);
  if (!m || ADMIN_IDS.indexOf(m.id) < 0) throw new Error('Accès réservé aux admins.');
}
function withLock(fn) {
  var l = LockService.getScriptLock(); l.waitLock(10000);
  try { return fn(); } finally { l.releaseLock(); }
}
function saveNews(tok, id, title, body) {
  adminOnly(tok);
  title = clip(title, 120); body = clip(body, 2000);
  if (!title) throw new Error('Titre requis.');
  return withLock(function () {
    var s = sh('annonces', ['id', 'titre', 'texte', 'date']);
    if (!id) { s.appendRow([Utilities.getUuid(), title, body, new Date().toISOString()]); return list(); }
    var ids = s.getRange(1, 1, s.getLastRow(), 1).getValues();
    for (var i = 1; i < ids.length; i++) {
      if (String(ids[i][0]) === id) { s.getRange(i + 1, 2, 1, 2).setValues([[title, body]]); break; }
    }
    return list();
  });
}
function deleteNews(tok, id) {
  adminOnly(tok);
  return withLock(function () {
    var s = sh('annonces', ['id', 'titre', 'texte', 'date']);
    var ids = s.getRange(1, 1, s.getLastRow(), 1).getValues();
    for (var i = 1; i < ids.length; i++) {
      if (String(ids[i][0]) === id) { s.deleteRow(i + 1); break; }
    }
    return list();
  });
}
function saveSite(tok, banner, tagline) {
  adminOnly(tok);
  return withLock(function () {
    var t = sh('site', ['cle', 'valeur']);
    if (t.getLastRow() > 1) t.getRange(2, 1, t.getLastRow() - 1, 2).clearContent();
    t.getRange(2, 1, 2, 2).setValues([['banner', clip(banner, 200)], ['tagline', clip(tagline, 400)]]);
    return getSite();
  });
}

// ===== Contrôle du bot Discord (admin seulement) =====
// Les actions passent par le bot sur Render (BOT_URL + BOT_API_KEY dans Propriétés du script).
function bot(method, path, payload) {
  var url = prop('BOT_URL');
  if (!url) throw new Error('BOT_URL manquant dans les propriétés du script.');
  var r = UrlFetchApp.fetch(url.replace(/\/$/, '') + '/api', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ key: prop('BOT_API_KEY'), method: method, path: path, payload: payload || null })
  });
  var o;
  try { o = JSON.parse(r.getContentText()); }
  catch (e) { throw new Error('Le bot ne répond pas (il se réveille peut-être, réessaie dans 1 minute).'); }
  if (o.message) throw new Error('Bot : ' + o.message);
  var j = {};
  try { j = o.body ? JSON.parse(o.body) : {}; } catch (e) {}
  if (o.status >= 400) throw new Error('Discord : ' + (j.message || o.status));
  return j;
}
function isId(v) { return /^\d{5,25}$/.test(String(v)); }
function botGuilds(tok) {
  adminOnly(tok);
  return bot('get', '/users/@me/guilds').map(function (g) { return { id: g.id, name: g.name, main: g.id === GUILD_ID }; });
}
function botChannels(tok, gid) {
  adminOnly(tok);
  if (!isId(gid)) throw new Error('Serveur invalide.');
  return bot('get', '/guilds/' + gid + '/channels')
    .filter(function (c) { return c.type === 0 || c.type === 5; })
    .map(function (c) { return { id: c.id, name: c.name }; });
}
function botMembers(tok) {
  adminOnly(tok);
  var out = [], after = '0';
  for (var i = 0; i < 5; i++) {
    var p = bot('get', '/guilds/' + GUILD_ID + '/members?limit=1000&after=' + after);
    out = out.concat(p);
    if (p.length < 1000) break;
    after = p[p.length - 1].user.id;
  }
  return out.map(function (m) {
    return { id: m.user.id, name: m.nick || m.user.global_name || m.user.username, bot: !!m.user.bot };
  });
}
function botSend(tok, channelId, text) {
  adminOnly(tok);
  text = clip(text, 2000);
  if (!isId(channelId) || !text) throw new Error('Salon ou message manquant.');
  bot('post', '/channels/' + channelId + '/messages', { content: text, allowed_mentions: { parse: [] } });
  return 'Message envoyé.';
}
function botDM(tok, userId, text) {
  adminOnly(tok);
  text = clip(text, 2000);
  if (!isId(userId) || !text) throw new Error('Utilisateur ou message manquant.');
  bot('get', '/guilds/' + GUILD_ID + '/members/' + userId); // doit être dans le serveur
  var ch = bot('post', '/users/@me/channels', { recipient_id: userId });
  bot('post', '/channels/' + ch.id + '/messages', { content: text, allowed_mentions: { parse: [] } });
  return 'Message privé envoyé.';
}
function botLeave(tok, gid) {
  adminOnly(tok);
  if (!isId(gid)) throw new Error('Serveur invalide.');
  if (gid === GUILD_ID) throw new Error('Pour protéger Tarbes RP, le bot ne peut pas quitter le serveur principal depuis le site.');
  bot('delete', '/users/@me/guilds/' + gid);
  return botGuilds(tok);
}

// ===== Garder le bot éveillé sur l'hébergeur gratuit =====
// Propriété du script à ajouter : BOT_URL (l'adresse Render du bot)
function ping() {
  var u = prop('BOT_URL');
  if (u) UrlFetchApp.fetch(u, { muteHttpExceptions: true });
}
// À lancer UNE SEULE FOIS à la main : crée un ping automatique toutes les 5 minutes.
function installPing() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ping') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ping').timeBased().everyMinutes(5).create();
}

// Appelée quand quelqu'un ouvre le site : réveille le bot s'il dormait.
function wakeBot() {
  try { ping(); } catch (e) {}
  return true;
}
