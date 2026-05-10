const fs = require("fs");
const http = require("http");
const path = require("path");
const qrcode = require("qrcode");
const fetch = require("node-fetch");

const { Client, GatewayIntentBits, WebhookClient } = require("discord.js");
const { Client: WAClient, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// ================= CONFIG =================

const DISCORD_TOKEN      = "Ton TOKEN";
const DISCORD_CHANNEL_ID = "ton id chanelle";
const WEBHOOK_URL        = "ton webhook URL";

const SERVER_IP   = "ton ip";
const SERVER_PORT = ton_port;

const MEDIA_DIR   = "./media";
const AVATAR_DIR  = "./avatars";
const LOG_FILE    = "./bridge.log";
const MUTES_FILE  = "./mutes.json";
const GROUP_FILE  = "./selected_group.json";

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
    res.writeHead(404); res.end(); return;
  }
  const filepath = path.join(__dirname, "avatars", basename);
  if (!fs.existsSync(filepath) || fs.statSync(filepath).isDirectory()) {
    res.writeHead(404); res.end(); return;
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

// ================= PERSISTENCE GROUPE =================

function loadSelectedGroup() {
  try {
    if (fs.existsSync(GROUP_FILE)) {
      const data = JSON.parse(fs.readFileSync(GROUP_FILE, "utf8"));
      if (data && data.groupId) {
        selectedGroupId = data.groupId;
        console.log("Groupe restaure : " + selectedGroupId);
      }
    }
  } catch (e) {
    console.error("Erreur chargement groupe :", e.message);
  }
}

function saveSelectedGroup() {
  try {
    fs.writeFileSync(GROUP_FILE, JSON.stringify({ groupId: selectedGroupId }, null, 2));
  } catch (e) {
    console.error("Erreur sauvegarde groupe :", e.message);
  }
}

loadSelectedGroup();

// ================= MUTES =================

let mutedUsers = {};

function loadMutes() {
  try {
    if (fs.existsSync(MUTES_FILE)) {
      mutedUsers = JSON.parse(fs.readFileSync(MUTES_FILE, "utf8"));
      const now = Date.now();
      for (const id of Object.keys(mutedUsers)) {
        if (mutedUsers[id] <= now) delete mutedUsers[id];
      }
      saveMutes();
      console.log("Mutes charges :", Object.keys(mutedUsers).length, "actifs");
    }
  } catch (e) {
    console.error("Erreur chargement mutes :", e.message);
    mutedUsers = {};
  }
}

function saveMutes() {
  try {
    fs.writeFileSync(MUTES_FILE, JSON.stringify(mutedUsers, null, 2));
  } catch (e) {
    console.error("Erreur sauvegarde mutes :", e.message);
  }
}

function isMuted(contactId) {
  const expireAt = mutedUsers[contactId];
  if (!expireAt) return false;
  if (Date.now() > expireAt) {
    delete mutedUsers[contactId];
    saveMutes();
    return false;
  }
  return true;
}

function parseDuration(str) {
  const match = str.match(/^(\d+)(m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit  = match[2].toLowerCase();
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  if (unit === "d") return value * 24 * 60 * 60 * 1000;
  return null;
}

function formatExpire(ts) {
  return new Date(ts).toLocaleString("fr-FR");
}

async function isGroupAdmin(contact, groupChat) {
  try {
    const participant = groupChat.participants.find(
      (p) => p.id._serialized === contact.id._serialized
    );
    return participant && (participant.isAdmin || participant.isSuperAdmin);
  } catch (_) {
    return false;
  }
}

async function resolveMentionedContact(msg) {
  try {
    if (typeof msg.getMentions === "function") {
      const mentioned = await msg.getMentions();
      if (mentioned && mentioned.length > 0) return mentioned[0];
    }
    if (msg.mentionedIds && msg.mentionedIds.length > 0) {
      const contact = await waClient.getContactById(msg.mentionedIds[0]);
      return contact || null;
    }
    return null;
  } catch (e) {
    console.error("Erreur resolveMention :", e.message);
    return null;
  }
}

loadMutes();

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

function getContactName(contact) {
  return contact.name || contact.pushname || contact.number || "Inconnu";
}

async function getAvatarUrl(contact) {
  if (!contact || !contact.id) return null;
  const id = contact.id._serialized;
  if (avatarCache.has(id)) return avatarCache.get(id);

  let picUrl = null;
  try {
    picUrl = await contact.getProfilePicUrl();
  } catch (_) {
    avatarCache.set(id, null);
    return null;
  }
  if (!picUrl) { avatarCache.set(id, null); return null; }

  try {
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

    const filename  = id.replace(/[^a-zA-Z0-9]/g, "_") + ".jpg";
    const filepath  = AVATAR_DIR + "/" + filename;
    fs.writeFileSync(filepath, Buffer.from(buffer));

    const publicUrl = "http://" + SERVER_IP + ":" + SERVER_PORT + "/" + filename;
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
    const contact  = await msg.getContact();
    if (!contact) return;
    const name     = getContactName(contact);
    const text     = msg.body || "";
    const senderId = contact.id._serialized;

    // ================= COMMANDES ADMIN =================

    const group = await getSelectedGroup();

    if (group && text.startsWith("!mute ")) {
      const adminCheck = await isGroupAdmin(contact, group);
      if (!adminCheck) {
        await group.sendMessage("⛔ Seuls les admins peuvent utiliser !mute.", { quotedMessageId: waId });
        return;
      }
      const parts       = text.trim().split(/\s+/);
      const durationStr = parts[parts.length - 1];
      const durationMs  = parseDuration(durationStr);
      if (!durationMs) {
        await group.sendMessage(
          "⛔ Format invalide. Exemple : `!mute @Personne 2d`\nUnités : m (minutes), h (heures), d (jours)",
          { quotedMessageId: waId }
        );
        return;
      }
      const target = await resolveMentionedContact(msg);
      if (!target) {
        await group.sendMessage("⛔ Mentionne un membre avec @.", { quotedMessageId: waId });
        return;
      }
      const targetId   = target.id._serialized;
      const targetName = getContactName(target);
      const targetIsAdmin = await isGroupAdmin(target, group);
      if (targetIsAdmin) {
        await group.sendMessage("⛔ Impossible de muter un admin du groupe.", { quotedMessageId: waId });
        return;
      }
      const expireAt = Date.now() + durationMs;
      mutedUsers[targetId] = expireAt;
      saveMutes();
      log("MUTE", name, targetName + " mute jusqu'au " + formatExpire(expireAt));
      await group.sendMessage(
        "🔇 *" + targetName + "* est mute jusqu'au *" + formatExpire(expireAt) +
        "*.\nSes messages ne seront pas transmis vers Discord.",
        { quotedMessageId: waId }
      );
      return;
    }

    if (group && text.startsWith("!unmute ")) {
      const adminCheck = await isGroupAdmin(contact, group);
      if (!adminCheck) {
        await group.sendMessage("⛔ Seuls les admins peuvent utiliser !unmute.", { quotedMessageId: waId });
        return;
      }
      const target = await resolveMentionedContact(msg);
      if (!target) {
        await group.sendMessage("⛔ Mentionne un membre avec @.", { quotedMessageId: waId });
        return;
      }
      const targetId   = target.id._serialized;
      const targetName = getContactName(target);
      if (mutedUsers[targetId]) {
        delete mutedUsers[targetId];
        saveMutes();
        log("UNMUTE", name, targetName + " demute");
        await group.sendMessage("🔊 *" + targetName + "* n'est plus mute.", { quotedMessageId: waId });
      } else {
        await group.sendMessage("🔊 *" + targetName + "* n'est pas mute.", { quotedMessageId: waId });
      }
      return;
    }

    // ================= FILTRAGE MUTE =================

    if (isMuted(senderId)) {
      log("MUTE_BLOCK", name, "Message bloque (mute actif)");
      return;
    }

    // ================= BRIDGE WA -> DC =================

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
      } catch (e) { console.error("Erreur media WA->DC :", e.message); }
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
    if (!contact) return;
    const name = getContactName(contact);
    await webhook.editMessage(discordId, {
      content: name + " : " + (msg.body || "[MEDIA]") + " *(edité)*",
    });
  } catch (e) { console.error("Erreur edition WA->DC :", e.message); }
});

// ================= WHATSAPP : SUPPRESSION =================

waClient.on("message_revoke_everyone", async (_, revokedMsg) => {
  if (!revokedMsg) return;
  const discordId = waToDiscord.get(revokedMsg.id._serialized);
  if (!discordId) return;
  try {
    await webhook.deleteMessage(discordId);
  } catch (e) {
    // "Unknown Message" = déjà supprimé ou trop vieux, on ignore silencieusement
    if (!e.message.includes("Unknown Message")) {
      console.error("Erreur suppression WA->DC :", e.message);
    }
  }
});

// ================= DISCORD -> WHATSAPP =================

discordClient.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== DISCORD_CHANNEL_ID) return;
  if (!waReady) return;

  const name    = message.member ? message.member.displayName : message.author.username;
  const content = message.content;

  // ================= COMMANDES DISCORD =================

  if (content === "!groupes") {
    try {
      const chats  = await waClient.getChats();
      const groups = chats.filter((c) => c.isGroup);
      if (!groups.length) { await message.reply("Aucun groupe trouve."); return; }
      let txt = "Groupes disponibles :\n";
      groups.forEach((g, i) => { txt += (i + 1) + ". " + g.name + "\n"; });
      await message.reply(txt);
    } catch (e) { console.error("Erreur !groupes :", e.message); }
    return;
  }

  if (content.startsWith("!select ")) {
    try {
      const index  = parseInt(content.split(" ")[1], 10) - 1;
      const chats  = await waClient.getChats();
      const groups = chats.filter((c) => c.isGroup);
      if (isNaN(index) || !groups[index]) {
        await message.reply("Numero invalide. Utilise !groupes.");
        return;
      }
      selectedGroupId = groups[index].id._serialized;
      saveSelectedGroup();
      await message.reply("Groupe selectionne : " + groups[index].name);
    } catch (e) { console.error("Erreur !select :", e.message); }
    return;
  }

  if (content === "!status") {
    try {
      const group = await getSelectedGroup();
      await message.reply(
        waReady
          ? "WhatsApp connecte\nGroupe : " + (group ? group.name : "aucun selectionne")
          : "WhatsApp non connecte"
      );
    } catch (e) { console.error("Erreur !status :", e.message); }
    return;
  }

  if (content === "!help") {
    await message.reply(
      "Commandes :\n" +
      "!groupes — Liste les groupes\n" +
      "!select <n> — Selectionne un groupe\n" +
      "!status — Etat connexion\n" +
      "!help — Cette aide"
    );
    return;
  }

  // ================= BRIDGE DC -> WA =================

  const group = await getSelectedGroup();
  if (!group) {
    await message.reply("Aucun groupe selectionne. Utilise !select <n>.");
    return;
  }

  const replyOptions = {};
  if (message.reference && message.reference.messageId) {
    const quotedWaId = discordToWa.get(message.reference.messageId);
    if (quotedWaId) replyOptions.quotedMessageId = quotedWaId;
  }

  // Envoi du texte
  if (content && !content.startsWith("!")) {
    try {
      const sent = await group.sendMessage("*" + name + "* : " + content, replyOptions);
      if (sent) {
        sentByBridge.add(sent.id._serialized);
        waToDiscord.set(sent.id._serialized, message.id);
        discordToWa.set(message.id, sent.id._serialized);
        log("DC->WA", name, content);
      } else {
        log("DC->WA_FAIL", name, "sendMessage a retourne null | msg: " + content);
      }
    } catch (e) {
      log("DC->WA_ERROR", name, "ERREUR: " + e.message + " | msg: " + content);
    }
  }

  // Envoi des pieces jointes
  for (const att of message.attachments.values()) {
    try {
      const media = await MessageMedia.fromUrl(att.url);
      const sent  = await group.sendMessage(media, Object.assign({}, replyOptions, { caption: "*" + name + "*" }));
      if (sent) {
        sentByBridge.add(sent.id._serialized);
        waToDiscord.set(sent.id._serialized, message.id);
        discordToWa.set(message.id, sent.id._serialized);
        log("DC->WA", name, "[MEDIA] " + att.name);
      } else {
        log("DC->WA_FAIL", name, "sendMessage media a retourne null | fichier: " + att.name);
      }
    } catch (e) {
      log("DC->WA_ERROR", name, "ERREUR media: " + e.message + " | fichier: " + att.name);
    }
  }
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
    const msgToEdit = await waClient.getMessageById(waId);
    if (msgToEdit) await msgToEdit.edit(newMessage.content);
  } catch (e) { console.error("Erreur edition DC->WA :", e.message); }
});

// ================= DISCORD : SUPPRESSION =================

discordClient.on("messageDelete", async (message) => {
  if (message.channel.id !== DISCORD_CHANNEL_ID) return;
  const waId = discordToWa.get(message.id);
  if (!waId) return;
  try {
    const msgToDelete = await waClient.getMessageById(waId);
    if (msgToDelete) await msgToDelete.delete(true);
  } catch (e) { console.error("Erreur suppression DC->WA :", e.message); }
});

// ================= START =================

waClient.initialize();