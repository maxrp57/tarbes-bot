// Garde le bot Tarbes RP en ligne. Le jeton vient de la variable BOT_TOKEN (jamais écrit ici).
const http = require('http');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');

// Nettoie le jeton : espaces, guillemets, ou le mot "Bot " collé par erreur.
const token = (process.env.BOT_TOKEN || '').trim().replace(/^["']|["']$/g, '').replace(/^Bot\s+/i, '');
console.log('Longueur du jeton :', token.length, '| nombre de points :', (token.match(/\./g) || []).length, '(attendu : environ 70 et 2)');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => {
  client.user.setPresence({ status: 'online', activities: [{ name: 'Tarbes RP', type: ActivityType.Playing }] });
  console.log('Bot en ligne :', client.user.tag);
});
client.login(token).catch((e) => console.error('Connexion refusée par Discord :', e.message));

// Petite page pour que l'hébergeur (et le cron) voient que le programme vit.
http.createServer((req, res) => res.end('ok')).listen(process.env.PORT || 3000);
