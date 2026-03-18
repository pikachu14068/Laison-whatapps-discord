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
const DISCORD_TOKEN = "TON_TOKEN_DISCORD";           // Exemple : "MTQx..."
const DISCORD_CHANNEL_ID = "ID_DU_CHANNEL";         // Exemple : "123456789012345678"

// WhatsApp
const waClient = new WAClient({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ["--no-sandbox","--disable-setuid-sandbox"] }
});

// Dossiers
const MEDIA_DIR = "./media";
const PP_DIR = "./pp";
const LOG_FILE = "./latest.log";

// Filtrage
const bannedWords = ["fdp", "ntm", "fils de pute", "nike ta mère"];
const userProfiles = {
  "33623964615@c.us": `${PP_DIR}/user1.png`,
  "33763079314@c.us": `${PP_DIR}/user2.png`,
  "33765694707@c.us": `${PP_DIR}/user3.png`,
  "33620503077@c.us": `${PP_DIR}/user4.png`,
  "33667662163@c.us": `${PP_DIR}/user5.png`,
  "33621526905@c.us": `${PP_DIR}/user6.png`,
  "33760511873@c.us": `${PP_DIR}/user7.png`,
  "33745610802@c.us": `${PP_DIR}/user8.png`,
  "33749833585@c.us": `${PP_DIR}/user9.png`,
  "33762952204@c.us": `${PP_DIR}/user10.png`,
  "33762234118@c.us": `${PP_DIR}/user11.png`,
  "33620866725@c.us": `${PP_DIR}/user12.png`,
  "33751238422@c.us": `${PP_DIR}/user13.png`,
  "33650056897@c.us": `${PP_DIR}/user14.png`,
  "33745284455@c.us": `${PP_DIR}/user15.png`,
  "33753452177@c.us": `${PP_DIR}/user16.png`,
  "33753204477@c.us": `${PP_DIR}/user17.png`,
  "33760000000@c.us": `${PP_DIR}/user18.png`
};

// ================= ETATS =================
let waReady = false;
const sentMessages = new Map(); // id WA -> id Discord pour reply
let selectedGroup = null;

// ================= LOG =================
function logMessage(source, user, content){
  const time = new Date().toLocaleString();
  fs.appendFileSync(LOG_FILE, `[${time}] ${source} | ${user} -> ${content}\n`);
}

// ================= DISCORD =================
discordClient.on("ready", () => { console.log("✅ Discord connecté"); });
discordClient.login(DISCORD_TOKEN);

// ================= WHATSAPP =================
waClient.on("ready", () => { console.log("✅ WhatsApp prêt"); waReady=true; });

// ================= QR =================
waClient.on("qr", async (qr) => {
  try {
    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
    const qrImage = await qrcode.toDataURL(qr);
    const base64 = qrImage.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync("qr.png", base64, "base64");
    await channel.send({ content:"📱 Scan le QR code WhatsApp :", files:["qr.png"] });
  } catch(e){ console.log("Erreur QR :", e); }
});

// ================= WHATSAPP → DISCORD =================
waClient.on("message", async (msg) => {
  if(!waReady) return;
  const msgId = msg.id._serialized;
  if(sentMessages.has(msgId)) { sentMessages.delete(msgId); return; }

  const contact = await msg.getContact();
  const name = contact.pushname || contact.number;
  const number = msg.from;

  if(bannedWords.some(w=>msg.body?.toLowerCase().includes(w))) return;

  try {
    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
    logMessage("WHATSAPP", name, msg.body||"[MEDIA]");

    let files = [];
    if(userProfiles[number]) files.push({ attachment:userProfiles[number], name:"pp.png" });

    if(msg.hasMedia){
      const media = await msg.downloadMedia();
      if(media){
        const ext = media.mimetype.split("/")[1];
        const path = `${MEDIA_DIR}/${Date.now()}.${ext}`;
        fs.writeFileSync(path, media.data, "base64");
        files.push(path);
      }
    }

    // Gestion reply
    let content = msg.body || " ";
    if(msg.hasQuotedMsg){
      const quoted = await msg.getQuotedMessage();
      content = `💬 Réponse à ${quoted.author || quoted.from} : ${quoted.body}\n${content}`;
    }

    const embed = {
      author:{name:name},
      description:content,
      color:0x000000,
      thumbnail:{ url: userProfiles[number] ? "attachment://pp.png" : undefined }
    };

    const sent = await channel.send({ embeds:[embed], files:files });
    sentMessages.set(msgId, sent.id);
  } catch(e){ console.log("Erreur WA → Discord :", e); }
});

// ================= DISCORD → WHATSAPP =================
discordClient.on("messageCreate", async (message) => {
  if(message.author.bot || !waReady) return;
  const name = message.member?.displayName || message.author.username;
  if (bannedWords.some(w=>message.content.toLowerCase().includes(w))) return;

  // Commandes
  if(message.content.startsWith("!groupes")){
    try{
      const chats = await waClient.getChats();
      const groups = chats.filter(c=>c.isGroup);
      let reply = groups.length? "📋 Groupes WhatsApp :\n" + groups.map((g,i)=>`${i+1}. ${g.name}`).join("\n") : "Aucun groupe WhatsApp trouvé.";
      await message.reply(reply);
    } catch(e){ await message.reply("Erreur !groupes"); console.log(e); }
    return;
  }

  if(message.content.startsWith("!select")){
    const args = message.content.split(" ");
    if(args.length<2){ await message.reply("Usage: !select <numéro>"); return; }
    const index = parseInt(args[1],10)-1;
    if(isNaN(index)){ await message.reply("Numéro invalide"); return; }
    try{
      const chats = await waClient.getChats();
      const groups = chats.filter(c=>c.isGroup);
      if(index<0 || index>=groups.length){ await message.reply("Numéro hors limite"); return; }
      selectedGroup = groups[index];
      await message.reply(`✅ Groupe sélectionné : ${selectedGroup.name}`);
    } catch(e){ console.log(e); await message.reply("Erreur !select"); }
    return;
  }

  try {
    const chats = await waClient.getChats();
    const group = selectedGroup || chats.find(c=>c.isGroup);
    if(!group) return;
    logMessage("DISCORD", name, message.content||"[MEDIA]");

    // Texte
    let text = message.content && !message.content.startsWith("!")? `*${name} :*\n${message.content}` : null;

    // Si reply Discord
    if(message.reference && message.reference.messageId){
      try{
        const replied = await message.channel.messages.fetch(message.reference.messageId);
        text = `💬 Réponse à ${replied.author.username} : ${replied.content}\n${message.content}`;
      } catch(e){ console.log("Erreur fetch reply :", e); }
    }

    if(text){
      const sent = await group.sendMessage(text);
      sentMessages.set(sent.id._serialized, message.id);
    }

    // Médias
    if(message.attachments.size>0){
      for(const att of message.attachments.values()){
        try{
          const media = await MessageMedia.fromUrl(att.url);
          const sent = await group.sendMessage(media);
          sentMessages.set(sent.id._serialized, message.id);

          const ext = att.name.split(".").pop();
          const path = `${MEDIA_DIR}/${Date.now()}.${ext}`;
          const res = await fetch(att.url);
          const buffer = await res.arrayBuffer();
          fs.writeFileSync(path, Buffer.from(buffer));
        } catch(e){ console.log("Erreur média :", e); }
      }
    }

  } catch(e){ console.log("Erreur Discord → WhatsApp :", e); }
});

// ================= INITIALISATION =================
if(!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);
waClient.initialize();