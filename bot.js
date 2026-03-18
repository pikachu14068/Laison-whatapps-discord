const fs = require("fs");
const qrcode = require("qrcode");
const fetch = require("node-fetch");

const { Client, GatewayIntentBits } = require("discord.js");
const { Client: WAClient, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// ================= VARIABLES PRINCIPALES =================

// Discord
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const DISCORD_TOKEN = "";           // <-- Remplir avec ton token Discord
const DISCORD_CHANNEL_ID = "";      // <-- Remplir avec l'ID du salon Discord

// WhatsApp
const waClient = new WAClient({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  }
});

// Dossiers
const MEDIA_DIR = "./media";
const PP_DIR = "./pp";
const LOG_FILE = "./latest.log";

// Filtrage
const bannedWords = [];   // <-- Ajouter les mots interdits ici de manière ["insulte 1", "insulte 2",]
const userProfiles = {    // <-- Ajouter les profils utilisateurs ici
  // "33600000001@c.us": `${PP_DIR}/user1.png`,
};

// ================= ETATS =================
let waReady = false;
const sentMessages = new Set();
let selectedGroup = null; // Groupe WhatsApp sélectionné via !select

// ================= LOG =================
function logMessage(source, user, content){
  const time = new Date().toLocaleString();
  const line = `[${time}] ${source} | ${user} -> ${content}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

// ================= DISCORD =================
discordClient.on("ready", () => {
  console.log("✅ Discord connecté");
});
discordClient.login(DISCORD_TOKEN);

// ================= WHATSAPP =================
waClient.on("ready", () => {
  console.log("✅ WhatsApp prêt");
  waReady = true;
});

// ================= QR =================
waClient.on("qr", async (qr) => {
  try {
    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
    const qrImage = await qrcode.toDataURL(qr);
    const base64 = qrImage.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync("qr.png", base64, "base64");

    await channel.send({
      content: "📱 Scan le QR code WhatsApp :",
      files: ["qr.png"]
    });
  } catch (e) {
    console.log("Erreur QR :", e);
  }
});

// ================= WHATSAPP → DISCORD =================
waClient.on("message", async (msg) => {
  if (!waReady) return;

  const msgId = msg.id._serialized;
  if (sentMessages.has(msgId)) { sentMessages.delete(msgId); return; }

  const contact = await msg.getContact();
  const name = contact.pushname || contact.number;
  const number = msg.from;

  if (bannedWords.some(w => msg.body?.toLowerCase().includes(w))) return;

  try {
    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
    logMessage("WHATSAPP", name, msg.body || "[MEDIA]");

    let files = [];
    if(userProfiles[number]){
      files.push({ attachment: userProfiles[number], name: "pp.png" });
    }

    if(msg.hasMedia){
      const media = await msg.downloadMedia();
      if(media){
        const ext = media.mimetype.split("/")[1];
        const filename = `${Date.now()}.${ext}`;
        const path = `${MEDIA_DIR}/${filename}`;
        fs.writeFileSync(path, media.data, "base64");
        files.push(path);
      }
    }

    const embed = {
      author: { name: name },
      description: msg.body || " ",
      color: 0x000000,
      thumbnail: { url: userProfiles[number] ? "attachment://pp.png" : undefined }
    };

    await channel.send({ embeds: [embed], files: files });
  } catch (e) {
    console.log("Erreur WA → Discord :", e);
  }
});

// ================= DISCORD → WHATSAPP =================
discordClient.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!waReady) return;

  const name = message.member?.displayName || message.author.username;
  if (bannedWords.some(w => message.content.toLowerCase().includes(w))) return;

  // ---------- COMMANDES !groupes ----------
  if(message.content.startsWith("!groupes")){
    try{
      const chats = await waClient.getChats();
      const groups = chats.filter(c => c.isGroup);
      if(groups.length === 0){
        await message.reply("Aucun groupe WhatsApp trouvé.");
      } else {
        let reply = "📋 Groupes WhatsApp disponibles :\n";
        groups.forEach((g, i) => { reply += `${i+1}. ${g.name}\n`; });
        await message.reply(reply);
      }
    } catch(e){
      console.log("Erreur !groupes :", e);
      await message.reply("Erreur lors de la récupération des groupes.");
    }
    return;
  }

  // ---------- COMMANDES !select ----------
  if(message.content.startsWith("!select")){
    const args = message.content.split(" ");
    if(args.length < 2){
      await message.reply("Utilisation : !select <numéro du groupe>");
      return;
    }

    const index = parseInt(args[1], 10) - 1;
    if(isNaN(index)){
      await message.reply("Numéro invalide.");
      return;
    }

    try{
      const chats = await waClient.getChats();
      const groups = chats.filter(c => c.isGroup);
      if(index < 0 || index >= groups.length){
        await message.reply("Numéro de groupe hors limite.");
        return;
      }

      selectedGroup = groups[index];
      await message.reply(`✅ Groupe sélectionné : ${selectedGroup.name}`);
    } catch(e){
      console.log("Erreur !select :", e);
      await message.reply("Erreur lors de la sélection du groupe.");
    }
    return;
  }

  // ---------- ENVOI DES MESSAGES AU GROUPE ----------
  try {
    const chats = await waClient.getChats();
    const group = selectedGroup || chats.find(c => c.isGroup);
    if (!group) return;

    logMessage("DISCORD", name, message.content || "[MEDIA]");

    // Texte
    if (message.content && !message.content.startsWith("!")){
      const sent = await group.sendMessage(`*${name} :*\n${message.content}`);
      sentMessages.add(sent.id._serialized);
    }

    // Médias
    if (message.attachments.size > 0){
      for(const att of message.attachments.values()){
        try {
          const media = await MessageMedia.fromUrl(att.url);
          const sent = await group.sendMessage(media);
          sentMessages.add(sent.id._serialized);

          const ext = att.name.split(".").pop();
          const filename = `${Date.now()}.${ext}`;
          const path = `${MEDIA_DIR}/${filename}`;
          const res = await fetch(att.url);
          const buffer = await res.arrayBuffer();
          fs.writeFileSync(path, Buffer.from(buffer));
        } catch (e) {
          console.log("Erreur média :", e);
        }
      }
    }
  } catch (e) {
    console.log("Erreur Discord → WhatsApp :", e);
  }
});

// ================= INITIALISATION =================
if(!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);
waClient.initialize();