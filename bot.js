const fs = require("fs");
const qrcode = require("qrcode");
const fetch = require("node-fetch");

const { Client, GatewayIntentBits, WebhookClient } = require("discord.js");
const { Client: WAClient, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// ================= VARIABLES =================

// Discord BOT
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const DISCORD_TOKEN = "";           // <-- MET TON TOKEN
const DISCORD_CHANNEL_ID = "";      // <-- MET L'ID DU SALON

// WEBHOOK DISCORD
const WEBHOOK_URL = "";             // <-- MET TON WEBHOOK
const webhook = new WebhookClient({ url: WEBHOOK_URL });

// WhatsApp
const waClient = new WAClient({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ["--no-sandbox","--disable-setuid-sandbox"]
  }
});

// Dossiers
const MEDIA_DIR = "./media";
const PP_DIR = "./pp";
const LOG_FILE = "./latest.log";

// Filtrage
const bannedWords = []; // <-- ajoute tes mots

const userProfiles = {
  // "33600000000@c.us": `${PP_DIR}/user1.png`,
};

// ================= ETATS =================
let waReady = false;
let selectedGroup = null;
const sentMessages = new Set();

// ================= LOG =================
function logMessage(source, user, content){
  const time = new Date().toLocaleString();
  fs.appendFileSync(LOG_FILE, `[${time}] ${source} | ${user} -> ${content}\n`);
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
  try{
    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);

    const qrImage = await qrcode.toDataURL(qr);
    const base64 = qrImage.replace(/^data:image\/png;base64,/, "");

    fs.writeFileSync("qr.png", base64, "base64");

    await channel.send({
      content: "📱 Scan le QR code WhatsApp :",
      files: ["qr.png"]
    });

  }catch(e){
    console.log("Erreur QR :", e);
  }
});

// ================= WHATSAPP → DISCORD =================
waClient.on("message", async (msg) => {

  if(!waReady) return;

  const msgId = msg.id._serialized;

  if(sentMessages.has(msgId)){
    sentMessages.delete(msgId);
    return;
  }

  const contact = await msg.getContact();
  const name = contact.pushname || contact.number;
  const number = msg.from;

  if(bannedWords.some(w => msg.body?.toLowerCase().includes(w))) return;

  try{

    logMessage("WHATSAPP", name, msg.body || "[MEDIA]");

    // Avatar
    let avatar = null;
    if(userProfiles[number]){
      avatar = userProfiles[number];
    }

    // Reply
    let content = msg.body || "";
    if(msg.hasQuotedMsg){
      const quoted = await msg.getQuotedMessage();
      content = `💬 Réponse à : ${quoted.body}\n${content}`;
    }

    // Médias
    let files = [];
    if(msg.hasMedia){
      const media = await msg.downloadMedia();

      if(media){
        const ext = media.mimetype.split("/")[1];
        const path = `${MEDIA_DIR}/${Date.now()}.${ext}`;

        fs.writeFileSync(path, media.data, "base64");
        files.push(path);
      }
    }

    await webhook.send({
      username: name,
      avatarURL: avatar ? "attachment://pp.png" : undefined,
      content: content || " ",
      files: avatar
        ? [{ attachment: avatar, name: "pp.png" }, ...files]
        : files
    });

  }catch(e){
    console.log("Erreur WA → Discord :", e);
  }

});

// ================= DISCORD → WHATSAPP =================
discordClient.on("messageCreate", async (message) => {

  if(message.author.bot) return;
  if(!waReady) return;

  const name = message.member?.displayName || message.author.username;

  if(bannedWords.some(w => message.content.toLowerCase().includes(w))) return;

  // ===== COMMANDES =====

  if(message.content.startsWith("!groupes")){
    const chats = await waClient.getChats();
    const groups = chats.filter(c => c.isGroup);

    let txt = "📋 Groupes :\n";
    groups.forEach((g,i)=> txt += `${i+1}. ${g.name}\n`);

    await message.reply(txt);
    return;
  }

  if(message.content.startsWith("!select")){
    const args = message.content.split(" ");
    const index = parseInt(args[1]) - 1;

    const chats = await waClient.getChats();
    const groups = chats.filter(c => c.isGroup);

    if(!groups[index]){
      await message.reply("❌ Groupe invalide");
      return;
    }

    selectedGroup = groups[index];
    await message.reply(`✅ Groupe : ${selectedGroup.name}`);
    return;
  }

  try{

    const chats = await waClient.getChats();
    const group = selectedGroup || chats.find(c => c.isGroup);

    if(!group) return;

    logMessage("DISCORD", name, message.content || "[MEDIA]");

    let text = null;

    // ===== MESSAGE NORMAL =====
    if(message.content && !message.content.startsWith("!")){
      text = `${name} : ${message.content}`;
    }

    // ===== REPLY DISCORD =====
    if(message.reference){
      try{
        const replied = await message.channel.messages.fetch(message.reference.messageId);

        text = `💬 ${name} répond à ${replied.author.username} : ${replied.content}\n${name} : ${message.content}`;

      }catch(e){
        console.log("Erreur reply Discord :", e);
      }
    }

    // ===== ENVOI TEXTE =====
    if(text){
      const sent = await group.sendMessage(text);
      sentMessages.add(sent.id._serialized);
    }

    // ===== MÉDIAS =====
    if(message.attachments.size > 0){
      for(const att of message.attachments.values()){
        try{
          const media = await MessageMedia.fromUrl(att.url);
          const sent = await group.sendMessage(media);
          sentMessages.add(sent.id._serialized);
        }catch(e){
          console.log("Erreur média :", e);
        }
      }
    }

  }catch(e){
    console.log("Erreur Discord → WhatsApp :", e);
  }

});

// ================= INIT =================
if(!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

waClient.initialize();