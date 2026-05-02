const fs = require("fs");
const http = require("http");
const path = require("path");
const qrcode = require("qrcode");
const fetch = require("node-fetch");

const { Client, GatewayIntentBits, WebhookClient } = require("discord.js");
const { Client: WAClient, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// ================= CONFIG =================

const DISCORD_TOKEN      = "tok token";
const DISCORD_CHANNEL_ID = "ton chanelle id";
const WEBHOOK_URL        = "ton webhook url";

const SERVER_IP   = "ton ip";
const SERVER_PORT = ton_port-ici;

const MEDIA_DIR  = "./media";
const AVATAR_DIR = "./avatars";
const LOG_FILE   = "./bridge.log";

// ================= CHROMIUM =================

const CHROMIUM_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

function findChromium() {
  for (const p of CHROMIUM_PATHS) {
    if (fs.existsSync(p)) {
      console.log("Chromium: " + p);
      return p;
    }
  }
  return undefined;
}

// ================= SERVEUR HTTP AVATARS =================

http.createServer((req, res) => {
  const basename = path.basename(req.url);
  if (!basename || basename === "." || basename === "/") {
    res.writeHead(404);
    res.end();
    return;
  }
  const filepath = path.join(__dirname, "avatars", basename);
  if (!fs.existsSync(filepath) || fs.statSync(filepath).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "image/jpeg" });
  fs.createReadStream(filepath).pipe(res);
}).listen(SERVER_PORT, () => {
  console.log("Serveur avatars port " + SERVER_PORT);
});

// ================= INIT =================

if (!fs.existsSync(MEDIA_DIR))  fs.mkdirSync(MEDIA_DIR,  { recursive: true });
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

const webhook = new WebhookClient({ url: WEBHOOK_URL });

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const waClient = new WAClient({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: findChromium(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  },
});

// ================= STATE =================

let waReady         = false;
let selectedGroupId = null;
let startTimestamp  = Math.floor(Date.now() / 1000);

const waToDiscord  = new Map();
const discordToWa  = new Map();
const sentByBridge = new Set();
const avatarCache  = new Map();

// ================= HELPERS =================

function log(source, user, content) {
  const time = new Date().toLocaleString("fr-FR");
  const line = "[" + time + "] [" + source + "] " + user + " : " + content + "\n";
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

function saveMedia(base64Data, mimetype, msgType) {
  let ext = (mimetype.split("/")[1] || "bin").split(";")[0];
  if (msgType === "ptt") ext = "ogg";
  const filename = Date.now() + "." + ext;
  const filepath = MEDIA_DIR + "/" + filename;
  fs.writeFileSync(filepath, base64Data, "base64");
  return { filename, filepath };
}

async function getDiscordChannel() {
  return discordClient.channels.fetch(DISCORD_CHANNEL_ID);
}

async function getSelectedGroup() {
  if (!selectedGroupId) return null;
  const chats = await waClient.getChats();
  return chats.find((c) => c.id._serialized === selectedGroupId) || null;
}

// Priorit� : nom que TU as donn� au contact > pushname WA > num�ro
function getContactName(contact) {
  return contact.name || contact.pushname || contact.number || "Inconnu";
}

// T�l�charge l'avatar via puppeteer et retourne une URL publique
async function getAvatarUrl(contact) {
  const id = contact.id._serialized;
  if (avatarCache.has(id)) return avatarCache.get(id);

  try {
    const picUrl = await contact.getProfilePicUrl();
    if (!picUrl) { avatarCache.set(id, null); return null; }

    const page   = waClient.pupPage;
    const buffer = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const ab  = await res.arrayBuffer();
        return Array.from(new Uint8Array(ab));
      } catch (_) { return null; }
    }, picUrl);

    if (!buffer || buffer.length === 0) { avatarCache.set(id, null); return null; }

    const filename = id.replace(/[^a-zA-Z0-9]/g, "_") + ".jpg";
    const filepath = AVATAR_DIR + "/" + filename;
    fs.writeFileSync(filepath, Buffer.from(buffer));

    const publicUrl = "http://" + SERVER_IP + ":" + SERVER_PORT + "/" + filename;
    console.log("Avatar OK : " + publicUrl);
    avatarCache.set(id, publicUrl);
    return publicUrl;

  } catch (e) {
    console.error("Erreur avatar :", e.message);
    avatarCache.set(id, null);
    return null;
  }
}

async function buildReplyPrefix(quotedDiscordId) {
  if (!quotedDiscordId) return "";
  try {
    const channel  = await getDiscordChannel();
    const original = await channel.messages.fetch(quotedDiscordId);
    const author   = original.author.username;
    const preview  = (original.content || "[MEDIA]").split("\n")[0].slice(0, 80);
    return "> **" + author + "** : " + preview + "\n";
  } catch (_) { return ""; }
}

// ================= DISCORD =================

discordClient.once("clientReady", () => {
  console.log("Discord connecte : " + discordClient.user.tag);
});

discordClient.login(DISCORD_TOKEN);

// ================= WHATSAPP : QR =================

waClient.on("qr", async (qr) => {
  try {
    const dataUrl = await qrcode.toDataURL(qr);
    const base64  = dataUrl.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync("qr.png", base64, "base64");
    const channel = await getDiscordChannel();
    await channel.send({ content: "Scanne ce QR code pour connecter WhatsApp", files: ["qr.png"] });
  } catch (e) { console.error("Erreur QR :", e.message); }
});

// ================= WHATSAPP : READY =================

waClient.on("ready", async () => {
  console.log("WhatsApp connecte");
  await new Promise((r) => setTimeout(r, 5000));
  startTimestamp = Math.floor(Date.now() / 1000);
  waReady = true;
  console.log("WhatsApp pret");
});

waClient.on("disconnected", (reason) => {
  console.warn("WhatsApp deconnecte :", reason);
  waReady = false;
});

waClient.on("auth_failure", (msg) => {
  console.error("Echec auth WhatsApp :", msg);
});

// ================= WHATSAPP -> DISCORD =================

waClient.on("message", async (msg) => {
  if (!waReady) return;
  if (!msg.from.endsWith("@g.us")) return;
  if (selectedGroupId && msg.from !== selectedGroupId) return;
  if (msg.timestamp < startTimestamp) return;

  const waId = msg.id._serialized;
  if (sentByBridge.has(waId)) { sentByBridge.delete(waId); return; }

  try {
    const contact   = await msg.getContact();
    const name      = getContactName(contact);
    const text      = msg.body || "";
    const avatarUrl = await getAvatarUrl(contact);

    log("WA->DC", name, text || "[MEDIA]");

    const files = [];
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          const { filename, filepath } = saveMedia(media.data, media.mimetype, msg.type);
          files.push({ attachment: filepath, name: filename });
        }
      } catch (e) { console.error("Erreur media :", e.message); }
    }

    let replyPrefix = "";
    if (msg.hasQuotedMsg) {
      try {
        const quoted          = await msg.getQuotedMessage();
        const quotedDiscordId = waToDiscord.get(quoted.id._serialized);
        replyPrefix           = await buildReplyPrefix(quotedDiscordId);
      } catch (_) {}
    }

    const finalContent = replyPrefix + (text || "");
    if (!finalContent.trim() && files.length === 0) return;

    const sent = await webhook.send({
      username:  name,
      avatarURL: avatarUrl || undefined,
      content:   finalContent || " ",
      files,
    });

    waToDiscord.set(waId, sent.id);
    discordToWa.set(sent.id, waId);

  } catch (e) { console.error("Erreur WA->DC :", e.message); }
});

// ================= WHATSAPP : EDITION =================

waClient.on("message_edit", async (msg) => {
  const discordId = waToDiscord.get(msg.id._serialized);
  if (!discordId) return;
  try {
    const contact = await msg.getContact();
    const name    = getContactName(contact);
    const channel = await getDiscordChannel();
    const dMsg    = await channel.messages.fetch(discordId);
    await dMsg.edit(name + " : " + (msg.body || "[MEDIA]") + " *(edite)*");
  } catch (e) { console.error("Erreur edition WA->DC :", e.message); }
});

// ================= WHATSAPP : SUPPRESSION =================

waClient.on("message_revoke_everyone", async (_, revokedMsg) => {
  if (!revokedMsg) return;
  const discordId = waToDiscord.get(revokedMsg.id._serialized);
  if (!discordId) return;
  try {
    const channel = await getDiscordChannel();
    const dMsg    = await channel.messages.fetch(discordId);
    await dMsg.delete();
  } catch (e) { console.error("Erreur suppression WA->DC :", e.message); }
});

// ================= DISCORD -> WHATSAPP =================

discordClient.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== DISCORD_CHANNEL_ID) return;
  if (!waReady) return;

  const name    = message.member ? message.member.displayName : message.author.username;
  const content = message.content;

  if (content === "!groupes") {
    const chats  = await waClient.getChats();
    const groups = chats.filter((c) => c.isGroup);
    if (!groups.length) { await message.reply("Aucun groupe trouve."); return; }
    let txt = "Groupes disponibles :\n";
    groups.forEach((g, i) => { txt += (i + 1) + ". " + g.name + "\n"; });
    await message.reply(txt);
    return;
  }

  if (content.startsWith("!select ")) {
    const index  = parseInt(content.split(" ")[1], 10) - 1;
    const chats  = await waClient.getChats();
    const groups = chats.filter((c) => c.isGroup);
    if (isNaN(index) || !groups[index]) {
      await message.reply("Numero invalide. Utilise !groupes.");
      return;
    }
    selectedGroupId = groups[index].id._serialized;
    await message.reply("Groupe selectionne : " + groups[index].name);
    return;
  }

  if (content === "!status") {
    const group = await getSelectedGroup();
    await message.reply(
      waReady
        ? "WhatsApp connecte\nGroupe : " + (group ? group.name : "aucun selectionne")
        : "WhatsApp non connecte"
    );
    return;
  }

  if (content === "!help") {
    await message.reply(
      "Commandes :\n" +
      "!groupes � Liste les groupes\n" +
      "!select <n> � Selectionne un groupe\n" +
      "!status � Etat connexion\n" +
      "!help � Cette aide"
    );
    return;
  }

  const group = await getSelectedGroup();
  if (!group) { await message.reply("Aucun groupe selectionne. Utilise !select <n>."); return; }

  try {
    log("DC->WA", name, content || "[MEDIA]");

    const replyOptions = {};
    if (message.reference && message.reference.messageId) {
      const quotedWaId = discordToWa.get(message.reference.messageId);
      if (quotedWaId) replyOptions.quotedMessageId = quotedWaId;
    }

    if (content && !content.startsWith("!")) {
      const sent = await group.sendMessage("*" + name + "* : " + content, replyOptions);
      if (sent) {
        sentByBridge.add(sent.id._serialized);
        waToDiscord.set(sent.id._serialized, message.id);
        discordToWa.set(message.id, sent.id._serialized);
      }
    }

    for (const att of message.attachments.values()) {
      try {
        const media = await MessageMedia.fromUrl(att.url);
        const sent  = await group.sendMessage(media, Object.assign({}, replyOptions, { caption: "*" + name + "*" }));
        if (sent) {
          sentByBridge.add(sent.id._serialized);
          waToDiscord.set(sent.id._serialized, message.id);
          discordToWa.set(message.id, sent.id._serialized);
        }
      } catch (e) { console.error("Erreur media DC->WA :", e.message); }
    }

  } catch (e) { console.error("Erreur DC->WA :", e.message); }
});

// ================= DISCORD : EDITION =================

discordClient.on("messageUpdate", async (_, newMessage) => {
  if (newMessage.author && newMessage.author.bot) return;
  if (newMessage.channel.id !== DISCORD_CHANNEL_ID) return;
  const waId = discordToWa.get(newMessage.id);
  if (!waId) return;
  const group = await getSelectedGroup();
  if (!group) return;
  try {
    const messages  = await group.fetchMessages({ limit: 50 });
    const msgToEdit = messages.find((m) => m.id._serialized === waId);
    if (msgToEdit) await msgToEdit.edit(newMessage.content);
  } catch (e) { console.error("Erreur edition DC->WA :", e.message); }
});

// ================= DISCORD : SUPPRESSION =================

discordClient.on("messageDelete", async (message) => {
  if (message.channel.id !== DISCORD_CHANNEL_ID) return;
  const waId = discordToWa.get(message.id);
  if (!waId) return;
  const group = await getSelectedGroup();
  if (!group) return;
  try {
    const messages    = await group.fetchMessages({ limit: 50 });
    const msgToDelete = messages.find((m) => m.id._serialized === waId);
    if (msgToDelete) await msgToDelete.delete(true);
  } catch (e) { console.error("Erreur suppression DC->WA :", e.message); }
});

// ================= START =================

waClient.initialize();