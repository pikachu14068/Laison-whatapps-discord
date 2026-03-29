const fs = require("fs");
const qrcode = require("qrcode");
const fetch = require("node-fetch");

const { Client, GatewayIntentBits, WebhookClient } = require("discord.js");
const { Client: WAClient, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// ================= CONFIG =================

const DISCORD_TOKEN = "TON_TOKEN";
const DISCORD_CHANNEL_ID = "TON_CHANNEL_ID";
const WEBHOOK_URL = "TON_WEBHOOK_URL";

const MEDIA_DIR = "./media";
const LOG_FILE = "./latest.log";

// ================= INIT =================

if(!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

const webhook = new WebhookClient({ url: WEBHOOK_URL });

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const waClient = new WAClient({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ["--no-sandbox","--disable-setuid-sandbox"]
  }
});

// ================= VARIABLES =================

let waReady = false;
let selectedGroupId = null;

const sentMessages = new Set();
const messageMap = new Map();

// ================= LOG =================

function logMessage(source, user, content){
  const time = new Date().toLocaleString();
  fs.appendFileSync(LOG_FILE, `[${time}] ${source} | ${user} -> ${content}\n`);
}

// ================= DISCORD =================

discordClient.on("ready", () => {
  console.log("✅ Discord prêt");
});

discordClient.login(DISCORD_TOKEN);

// ================= QR =================

waClient.on("qr", async (qr) => {
  const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);

  const qrImage = await qrcode.toDataURL(qr);
  const base64 = qrImage.replace(/^data:image\/png;base64,/, "");

  fs.writeFileSync("qr.png", base64, "base64");

  await channel.send({
    content: "📱 Scan le QR code WhatsApp",
    files: ["qr.png"]
  });
});

// ================= READY =================

waClient.on("ready", () => {
  console.log("✅ WhatsApp prêt");
  waReady = true;
});

// ================= WA → DISCORD =================

waClient.on("message", async (msg) => {

  if(!waReady) return;
  if(!msg.from.endsWith("@g.us")) return;
  if(selectedGroupId && msg.from !== selectedGroupId) return;

  const msgId = msg.id._serialized;

  if(sentMessages.has(msgId)){
    sentMessages.delete(msgId);
    return;
  }

  const contact = await msg.getContact();
  const name = contact.pushname || contact.number;

  try {

    logMessage("WHATSAPP", name, msg.body || "[MEDIA]");

    let files = [];
    let content = msg.body || " ";

    // ===== MEDIA =====
    if(msg.hasMedia){
      const media = await msg.downloadMedia();

      if(media){

        let ext = media.mimetype.split("/")[1];

        // 🔥 FIX VOCAL → .ogg
        if(msg.type === "ptt"){
          ext = "ogg";
        }

        const filename = `${Date.now()}.${ext}`;
        const path = `${MEDIA_DIR}/${filename}`;

        fs.writeFileSync(path, media.data, "base64");

        files.push({
          attachment: path,
          name: filename
        });
      }
    }

    const sent = await webhook.send({
      username: name,
      content: content,
      files: files
    });

    messageMap.set(sent.id, msgId);

  } catch(e){
    console.log("Erreur WA → Discord :", e);
  }

});

// ================= DISCORD → WHATSAPP =================

discordClient.on("messageCreate", async (message) => {

  if(message.author.bot) return;
  if(!waReady) return;

  const name = message.member?.displayName || message.author.username;

  // ===== COMMANDES =====

  if(message.content === "!groupes"){
    const chats = await waClient.getChats();
    const groups = chats.filter(c => c.isGroup);

    let txt = "📂 Groupes :\n";
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

    selectedGroupId = groups[index].id._serialized;

    await message.reply(`✅ Groupe sélectionné : ${groups[index].name}`);
    return;
  }

  // ===== ENVOI =====

  try {

    const chats = await waClient.getChats();
    const group = chats.find(c => c.id._serialized === selectedGroupId) || chats.find(c => c.isGroup);

    if(!group) return;

    logMessage("DISCORD", name, message.content || "[MEDIA]");

    let sentMsg = null;

    if(message.content && !message.content.startsWith("!")){
      sentMsg = await group.sendMessage(`${name} : ${message.content}`);
    }

    if(sentMsg){
      messageMap.set(message.id, sentMsg.id._serialized);
    }

    // ===== MEDIA =====

    if(message.attachments.size > 0){
      for(const att of message.attachments.values()){
        try{
          const media = await MessageMedia.fromUrl(att.url);

          const sent = await group.sendMessage(media);

          messageMap.set(message.id, sent.id._serialized);

          const buffer = await (await fetch(att.url)).arrayBuffer();
          fs.writeFileSync(`${MEDIA_DIR}/${Date.now()}`, Buffer.from(buffer));

        }catch(e){
          console.log("Erreur média :", e);
        }
      }
    }

  } catch(e){
    console.log("Erreur Discord → WhatsApp :", e);
  }

});

// ================= START =================

waClient.initialize();