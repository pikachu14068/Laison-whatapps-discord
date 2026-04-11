const fs = require("fs");
const qrcode = require("qrcode");
const fetch = require("node-fetch");

const { Client, GatewayIntentBits, WebhookClient } = require("discord.js");
const { Client: WAClient, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// ================= CONFIG =================

const DISCORD_TOKEN     = "Ton token discord";
const DISCORD_CHANNEL_ID = "Ton chanelle ID";
const WEBHOOK_URL       = "ton webhook url";

const MEDIA_DIR = "./media";
const LOG_FILE  = "./bridge.log";

// ================= INIT =================

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

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
  puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

// ================= STATE =================

let waReady       = false;
let selectedGroupId = null;

// Bidirectionnal message ID map : WA id <-> Discord id
const waToDiscord = new Map(); // waId -> discordId
const discordToWa = new Map(); // discordId -> waId

// IDs of messages we sent ourselves (to avoid echo)
const sentByBridge = new Set();

// ================= HELPERS =================

function log(source, user, content) {
  const time = new Date().toLocaleString("fr-FR");
  const line = `[${time}] [${source}] ${user} : ${content}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

function saveMedia(base64Data, mimetype, msgType) {
  let ext = mimetype.split("/")[1] || "bin";
  if (msgType === "ptt") ext = "ogg";
  const filename = `${Date.now()}.${ext}`;
  const filepath = `${MEDIA_DIR}/${filename}`;
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

// ================= DISCORD CLIENT =================

discordClient.once("ready", () => {
  console.log(`✅ Discord connecté : ${discordClient.user.tag}`);
});

discordClient.login(DISCORD_TOKEN);

// ================= WHATSAPP : QR =================

waClient.on("qr", async (qr) => {
  try {
    const dataUrl = await qrcode.toDataURL(qr);
    const base64  = dataUrl.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync("qr.png", base64, "base64");

    const channel = await getDiscordChannel();
    await channel.send({
      content: "📱 Scanne ce QR code pour connecter WhatsApp",
      files: ["qr.png"],
    });
  } catch (e) {
    console.error("Erreur envoi QR :", e.message);
  }
});

// ================= WHATSAPP : READY =================

waClient.on("ready", () => {
  console.log("✅ WhatsApp connecté");
  waReady = true;
});

waClient.on("disconnected", (reason) => {
  console.warn("⚠️ WhatsApp déconnecté :", reason);
  waReady = false;
});

// ================= WHATSAPP → DISCORD =================

waClient.on("message", async (msg) => {
  if (!waReady) return;

  // Groupes uniquement
  if (!msg.from.endsWith("@g.us")) return;

  // Filtrer par groupe sélectionné
  if (selectedGroupId && msg.from !== selectedGroupId) return;

  const waId = msg.id._serialized;

  // Éviter l'écho des messages envoyés par le bridge
  if (sentByBridge.has(waId)) {
    sentByBridge.delete(waId);
    return;
  }

  try {
    const contact = await msg.getContact();
    const name    = contact.pushname || contact.number;
    const text    = msg.body || "";

    log("WA→DC", name, text || "[MEDIA]");

    const files = [];

    // Téléchargement média
    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      if (media) {
        const { filename, filepath } = saveMedia(media.data, media.mimetype, msg.type);
        files.push({ attachment: filepath, name: filename });
      }
    }

    // Gestion de la citation (reply)
    const replyOptions = {};
    if (msg.hasQuotedMsg) {
      const quoted          = await msg.getQuotedMessage();
      const quotedDiscordId = waToDiscord.get(quoted.id._serialized);
      if (quotedDiscordId) {
        replyOptions.reply = { messageReference: quotedDiscordId };
      }
    }

    const sent = await webhook.send({
      username: name,
      content:  text || " ",
      files,
      ...replyOptions,
    });

    // Enregistrer la correspondance d'IDs
    waToDiscord.set(waId, sent.id);
    discordToWa.set(sent.id, waId);

  } catch (e) {
    console.error("Erreur WA→DC :", e.message);
  }
});

// ================= WHATSAPP : MESSAGE ÉDITÉ =================

waClient.on("message_edit", async (msg) => {
  const discordId = waToDiscord.get(msg.id._serialized);
  if (!discordId) return;

  try {
    const contact = await msg.getContact();
    const name    = contact.pushname || contact.number;
    const channel = await getDiscordChannel();
    const dMsg    = await channel.messages.fetch(discordId);
    await dMsg.edit(`${name} : ${msg.body || "[MEDIA]"} *(édité)*`);
  } catch (e) {
    console.error("Erreur édition WA→DC :", e.message);
  }
});

// ================= WHATSAPP : MESSAGE SUPPRIMÉ =================

waClient.on("message_revoke_everyone", async (_, revokedMsg) => {
  if (!revokedMsg) return;
  const discordId = waToDiscord.get(revokedMsg.id._serialized);
  if (!discordId) return;

  try {
    const channel = await getDiscordChannel();
    const dMsg    = await channel.messages.fetch(discordId);
    await dMsg.delete();
  } catch (e) {
    console.error("Erreur suppression WA→DC :", e.message);
  }
});

// ================= DISCORD → WHATSAPP =================

discordClient.on("messageCreate", async (message) => {
  // Ignorer bots et autres canaux
  if (message.author.bot) return;
  if (message.channel.id !== DISCORD_CHANNEL_ID) return;
  if (!waReady) return;

  const name    = message.member?.displayName || message.author.username;
  const content = message.content;

  // ===== COMMANDES =====

  if (content === "!groupes") {
    const chats  = await waClient.getChats();
    const groups = chats.filter((c) => c.isGroup);

    if (!groups.length) {
      await message.reply("❌ Aucun groupe trouvé.");
      return;
    }

    let txt = "📋 **Groupes disponibles :**\n";
    groups.forEach((g, i) => (txt += `\`${i + 1}\` — ${g.name}\n`));
    await message.reply(txt);
    return;
  }

  if (content.startsWith("!select ")) {
    const index  = parseInt(content.split(" ")[1], 10) - 1;
    const chats  = await waClient.getChats();
    const groups = chats.filter((c) => c.isGroup);

    if (isNaN(index) || !groups[index]) {
      await message.reply("❌ Numéro de groupe invalide. Utilise `!groupes` pour voir la liste.");
      return;
    }

    selectedGroupId = groups[index].id._serialized;
    await message.reply(`✅ Groupe sélectionné : **${groups[index].name}**`);
    return;
  }

  if (content === "!status") {
    const group = await getSelectedGroup();
    await message.reply(
      waReady
        ? `✅ WhatsApp connecté\n📌 Groupe : **${group ? group.name : "aucun sélectionné"}**`
        : "❌ WhatsApp non connecté"
    );
    return;
  }

  if (content === "!help") {
    await message.reply(
      "**Commandes disponibles :**\n" +
      "`!groupes` — Liste les groupes WhatsApp\n" +
      "`!select <numéro>` — Sélectionne un groupe\n" +
      "`!status` — Affiche l'état de la connexion\n" +
      "`!help` — Affiche cette aide"
    );
    return;
  }

  // ===== ENVOI VERS WHATSAPP =====

  const group = await getSelectedGroup();
  if (!group) {
    await message.reply("⚠️ Aucun groupe sélectionné. Utilise `!select <numéro>`.");
    return;
  }

  try {
    log("DC→WA", name, content || "[MEDIA]");

    // Gestion de la citation (reply)
    const replyOptions = {};
    if (message.reference?.messageId) {
      const quotedWaId = discordToWa.get(message.reference.messageId);
      if (quotedWaId) replyOptions.quotedMessageId = quotedWaId;
    }

    // Texte
    if (content && !content.startsWith("!")) {
      const sent = await group.sendMessage(`*${name}* : ${content}`, replyOptions);
      if (sent) {
        sentByBridge.add(sent.id._serialized);
        waToDiscord.set(sent.id._serialized, message.id);
        discordToWa.set(message.id, sent.id._serialized);
      }
    }

    // Médias
    for (const att of message.attachments.values()) {
      try {
        const media = await MessageMedia.fromUrl(att.url);
        const sent  = await group.sendMessage(media, { ...replyOptions, caption: `*${name}*` });
        if (sent) {
          sentByBridge.add(sent.id._serialized);
          waToDiscord.set(sent.id._serialized, message.id);
          discordToWa.set(message.id, sent.id._serialized);
        }
      } catch (e) {
        console.error("Erreur envoi média DC→WA :", e.message);
      }
    }

  } catch (e) {
    console.error("Erreur DC→WA :", e.message);
  }
});

// ================= DISCORD : MESSAGE ÉDITÉ =================

discordClient.on("messageUpdate", async (_, newMessage) => {
  if (newMessage.author?.bot) return;
  if (newMessage.channel.id !== DISCORD_CHANNEL_ID) return;

  const waId = discordToWa.get(newMessage.id);
  if (!waId) return;

  const group = await getSelectedGroup();
  if (!group) return;

  try {
    const messages  = await group.fetchMessages({ limit: 50 });
    const msgToEdit = messages.find((m) => m.id._serialized === waId);
    if (msgToEdit) await msgToEdit.edit(newMessage.content);
  } catch (e) {
    console.error("Erreur édition DC→WA :", e.message);
  }
});

// ================= DISCORD : MESSAGE SUPPRIMÉ =================

discordClient.on("messageDelete", async (message) => {
  if (message.channel.id !== DISCORD_CHANNEL_ID) return;

  const waId = discordToWa.get(message.id);
  if (!waId) return;

  const group = await getSelectedGroup();
  if (!group) return;

  try {
    const messages     = await group.fetchMessages({ limit: 50 });
    const msgToDelete  = messages.find((m) => m.id._serialized === waId);
    if (msgToDelete) await msgToDelete.delete(true);
  } catch (e) {
    console.error("Erreur suppression DC→WA :", e.message);
  }
});

// ================= START =================

waClient.initialize();