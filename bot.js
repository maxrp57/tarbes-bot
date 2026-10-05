// Garde le bot Tarbes RP en ligne. Le jeton vient de la variable BOT_TOKEN (jamais écrit ici).
const http = require('http');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', () => {
  client.user.setPresence({ status: 'online', activities: [{ name: 'Tarbes RP', type: ActivityType.Playing }] });
  console.log('Bot en ligne :', client.user.tag);
});
client.login(process.env.BOT_TOKEN);

// Petite page pour que l'hébergeur (et le ping Google) voient que le programme vit.
http.createServer((req, res) => res.end('ok')).listen(process.env.PORT || 3000);
