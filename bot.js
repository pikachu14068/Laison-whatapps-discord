require("dotenv").config();

const fs       = require("fs");
const qrcode   = require("qrcode");
const fetch    = require("node-fetch");
const FormData = require("form-data");
const pino     = require("pino");
const { Boom } = require("@hapi/boom");

const {
  Client,
  GatewayIntentBits,
  WebhookClient,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  getContentType,
  DisconnectReason,
  proto,
} = require("@whiskeysockets/baileys");

// ==========================================================================
// CONFIG
// ==========================================================================

const DISCORD_TOKEN      = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const WEBHOOK_URL        = process.env.WEBHOOK_URL;
const DISCORD_CLIENT_ID  = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID   = process.env.DISCORD_GUILD_ID;
const GROQ_API_KEY       = process.env.GROQ_API_KEY;

const REQUIRED_ENV_VARS = {
  DISCORD_TOKEN, DISCORD_CHANNEL_ID, WEBHOOK_URL,
  DISCORD_CLIENT_ID, DISCORD_GUILD_ID, GROQ_API_KEY,
};

for (const [key, value] of Object.entries(REQUIRED_ENV_VARS)) {
  if (!value) {
    console.error(`Variable d'environnement manquante : ${key}. Vérifie ton fichier .env.`);
    process.exit(1);
  }
}

const MEDIA_DIR  = "./media";
const LOG_FILE   = "./bridge.log";
const MUTES_FILE = "./mutes.json";
const GROUP_FILE = "./selected_group.json";
const LINKS_FILE = "./links.json";
const AUTH_DIR   = "./wa_auth";

const GUILD_MEMBERS_CACHE_TTL = 15 * 1000;
const GROUP_CACHE_TTL         = 60 * 1000;
const MAX_DISCORD_FILE_SIZE   = 8 * 1024 * 1024;

const waLogger = pino({ level: "silent" });

// ==========================================================================
// INIT CLIENTS
// ==========================================================================

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const webhook = new WebhookClient({ url: WEBHOOK_URL });

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

let sock = null;

// ==========================================================================
// ETAT GLOBAL
// ==========================================================================

let waReady         = false;
let selectedGroupId = null;
let startTimestamp  = Math.floor(Date.now() / 1000);

const waToDiscord      = new Map();
const discordToWa      = new Map();
const sentByBridge      = new Set();
const avatarCache       = new Map();
const contactNamesCache = new Map();  
const waMessageStore    = new Map(); 

// ==========================================================================
// LOGGING
// ==========================================================================

function log(source, user, content) {
  const time = new Date().toLocaleString("fr-FR");
  const line = `[${time}] [${source}] ${user} : ${content}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

function logError(context, e) {
  console.error(`${context} :`, e && e.stack ? e.stack : e);
}

// ==========================================================================
// RESILIENCE : REDEMARRAGE AUTO DU CLIENT WHATSAPP
// ==========================================================================

function isFatalWaError(message) {
  if (!message) return false;
  const m = String(message);
  return (
    m.includes("Connection Closed") ||
    m.includes("Stream Errored") ||
    m.includes("Timed Out") ||
    m.includes("Socket Closed") ||
    m.includes("Cannot read properties of undefined")
  );
}

let waRestartInProgress = false;

async function restartWaClient(reason) {
  if (waRestartInProgress) return;
  waRestartInProgress = true;
  waReady = false;
  invalidateGroupCache();
  console.error(`Redémarrage du client WhatsApp suite à : ${reason}`);

  try {
    const channel = await getDiscordChannel();
    await channel.send("⚠️ Le pont WhatsApp a rencontré un problème et se reconnecte automatiquement...");
  } catch (_) {}

  try {
    if (sock) sock.end(new Error(reason));
  } catch (e) {
    logError("Erreur end() pendant le redémarrage", e);
  }

  setTimeout(() => {
    startWaSocket().catch((e) => {
      logError("Erreur réinitialisation du client WA", e);
      waRestartInProgress = false;
    });
  }, 5000);
}

async function forceQrResend() {
  if (waRestartInProgress) {
    console.log("Régénération QR ignorée : un redémarrage est déjà en cours.");
    return;
  }
  waRestartInProgress = true;
  waReady = false;
  invalidateGroupCache();
  console.log("Régénération manuelle du QR code demandée (/qr ou !qr).");

  try {
    if (sock) await sock.logout().catch(() => {});
  } catch (e) {
    logError("Erreur logout() pendant la régénération QR", e);
  }
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch (e) {
    logError("Erreur suppression session pendant la régénération QR", e);
  }

  setTimeout(() => {
    startWaSocket().catch((e) => {
      logError("Erreur réinitialisation WA (/qr)", e);
      waRestartInProgress = false;
    });
  }, 1000);
}

process.on("unhandledRejection", (reason) => {
  const msg = (reason && reason.message) || String(reason);
  logError("Rejet de promesse non géré", reason);
  if (isFatalWaError(msg)) restartWaClient(`unhandledRejection: ${msg}`);
});

process.on("uncaughtException", (err) => {
  logError("Exception non interceptée", err);
  if (isFatalWaError(err.message)) restartWaClient(`uncaughtException: ${err.message}`);
});

// ==========================================================================
// PERSISTANCE : GROUPE SELECTIONNE
// ==========================================================================

function loadSelectedGroup() {
  try {
    if (!fs.existsSync(GROUP_FILE)) return;
    const raw = fs.readFileSync(GROUP_FILE, "utf8").trim();
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && data.groupId) {
      selectedGroupId = data.groupId;
      console.log(`Groupe restauré : ${selectedGroupId}`);
    }
  } catch (e) {
    logError("Erreur chargement groupe", e);
  }
}

function saveSelectedGroup() {
  try {
    fs.writeFileSync(GROUP_FILE, JSON.stringify({ groupId: selectedGroupId }, null, 2));
  } catch (e) {
    logError("Erreur sauvegarde groupe", e);
  }
}

// ==========================================================================
// PERSISTANCE : LIENS DISCORD <-> WHATSAPP (pour la sync des mentions @)
// ==========================================================================

let accountLinks = {};

function loadLinks() {
  try {
    if (!fs.existsSync(LINKS_FILE)) return;
    const raw = fs.readFileSync(LINKS_FILE, "utf8").trim();
    accountLinks = raw ? JSON.parse(raw) : {};
    console.log("Liens chargés :", Object.keys(accountLinks).length);
  } catch (e) {
    logError("Erreur chargement liens", e);
    accountLinks = {};
  }
}

function saveLinks() {
  try {
    fs.writeFileSync(LINKS_FILE, JSON.stringify(accountLinks, null, 2));
  } catch (e) {
    logError("Erreur sauvegarde liens", e);
  }
}

function normalizeWaNumber(raw) {
  return String(raw).replace(/[^\d]/g, "");
}

function setLink(discordId, discordUsername, waNumber) {
  const number = normalizeWaNumber(waNumber);
  for (const id of Object.keys(accountLinks)) {
    if (accountLinks[id].waNumber === number && id !== discordId) {
      delete accountLinks[id];
    }
  }
  accountLinks[discordId] = { discordUsername, waNumber: number };
  saveLinks();
}

function findLinkByWaNumber(number) {
  const norm = normalizeWaNumber(number);
  for (const id of Object.keys(accountLinks)) {
    if (accountLinks[id].waNumber === norm) return { discordId: id, ...accountLinks[id] };
  }
  return null;
}

function findLinkByDiscordId(discordId) {
  const link = accountLinks[discordId];
  return link ? { discordId, ...link } : null;
}

// ==========================================================================
// CACHE : MEMBRES DU SERVEUR DISCORD
// ==========================================================================

let guildMembersCacheAt = 0;

async function getCachedGuildMembers() {
  const guild = discordClient.guilds.cache.first();
  if (!guild) return null;
  const now = Date.now();
  if (now - guildMembersCacheAt > GUILD_MEMBERS_CACHE_TTL) {
    await guild.members.fetch();
    guildMembersCacheAt = now;
  }
  return guild;
}

function findGuildMemberByName(guild, name) {
  if (!guild || !name) return null;
  const nameLower = String(name).toLowerCase().trim();
  if (!nameLower) return null;

  const humans = guild.members.cache.filter((m) => !m.user.bot);

  const exact = humans.find((m) => {
    const nick = (m.nickname || "").toLowerCase();
    const user = m.user.username.toLowerCase();
    return nick === nameLower || user === nameLower;
  });
  if (exact) return exact;

  const fuzzy = humans.find((m) => {
    const nick = (m.nickname || "").toLowerCase();
    const user = m.user.username.toLowerCase();
    return (nick && (nick.includes(nameLower) || nameLower.includes(nick))) ||
           (user && (user.includes(nameLower) || nameLower.includes(user)));
  });
  return fuzzy || null;
}

// ==========================================================================
// CACHE : GROUPE WHATSAPP SELECTIONNE (Baileys : groupMetadata)
// ==========================================================================

const groupMetadataCache = new Map();

function invalidateGroupCache() {
  groupMetadataCache.clear();
}

async function fetchGroupMetadataCached(jid) {
  const cached = groupMetadataCache.get(jid);
  const now = Date.now();
  if (cached && now - cached.at < GROUP_CACHE_TTL) return cached.metadata;
  const metadata = await sock.groupMetadata(jid);
  groupMetadataCache.set(jid, { metadata, at: now });
  return metadata;
}

async function sendWaMessage(jid, content, options = {}) {
  const payload = typeof content === "string" ? { text: content } : { ...content };
  if (options.mentions && options.mentions.length) payload.mentions = options.mentions;

  const sendOptions = {};
  if (options.quotedMessageId) {
    const quotedMsg = waMessageStore.get(options.quotedMessageId);
    if (quotedMsg) sendOptions.quoted = quotedMsg;
  }

  const sent = await sock.sendMessage(jid, payload, sendOptions);
  if (sent) rememberWaMessage(sent);
  return sent;
}

async function getSelectedGroup() {
  if (!selectedGroupId) return null;
  try {
    const metadata = await fetchGroupMetadataCached(selectedGroupId);
    return {
      id: selectedGroupId,
      name: metadata.subject || "Groupe sans nom",
      participants: metadata.participants || [],
      sendMessage: (content, options) => sendWaMessage(selectedGroupId, content, options),
    };
  } catch (e) {
    logError("getSelectedGroup a échoué", e);
    return null;
  }
}

async function getWaGroups() {
  const all = await sock.groupFetchAllParticipating();
  return Object.values(all).map((g) => ({
    id: { _serialized: g.id },
    name: g.subject || "Groupe sans nom",
  }));
}

// ==========================================================================
// MUTES
// ==========================================================================

let mutedUsers = {};

function loadMutes() {
  try {
    if (!fs.existsSync(MUTES_FILE)) return;
    const raw = fs.readFileSync(MUTES_FILE, "utf8").trim();
    mutedUsers = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    for (const id of Object.keys(mutedUsers)) {
      if (mutedUsers[id] <= now) delete mutedUsers[id];
    }
    saveMutes();
    console.log("Mutes chargés :", Object.keys(mutedUsers).length, "actifs");
  } catch (e) {
    logError("Erreur chargement mutes", e);
    mutedUsers = {};
  }
}

function saveMutes() {
  try {
    fs.writeFileSync(MUTES_FILE, JSON.stringify(mutedUsers, null, 2));
  } catch (e) {
    logError("Erreur sauvegarde mutes", e);
  }
}

function isMuted(jid) {
  const expireAt = mutedUsers[jid];
  if (!expireAt) return false;
  if (Date.now() > expireAt) {
    delete mutedUsers[jid];
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

function isGroupAdmin(jid, group) {
  try {
    const participant = group.participants.find((p) => p.id === jid);
    return Boolean(participant && (participant.admin === "admin" || participant.admin === "superadmin"));
  } catch (_) {
    return false;
  }
}

function resolveMentionedJid(msg) {
  const mentioned = getMentionedJids(msg);
  return mentioned.length > 0 ? mentioned[0] : null;
}

// ==========================================================================
// HELPERS BAILEYS : LECTURE DU CONTENU DES MESSAGES
// ==========================================================================

function getMessageContentType(msg) {
  return msg && msg.message ? getContentType(msg.message) : null;
}

function extractText(msg) {
  const type = getMessageContentType(msg);
  if (!type) return "";
  const m = msg.message;
  switch (type) {
    case "conversation":        return m.conversation || "";
    case "extendedTextMessage": return m.extendedTextMessage.text || "";
    case "imageMessage":        return m.imageMessage.caption || "";
    case "videoMessage":        return m.videoMessage.caption || "";
    case "documentMessage":     return m.documentMessage.caption || "";
    default: return "";
  }
}

function getContextInfo(msg) {
  const type = getMessageContentType(msg);
  if (!type) return null;
  const content = msg.message[type];
  return (content && content.contextInfo) || null;
}

function getMentionedJids(msg) {
  const ctx = getContextInfo(msg);
  return (ctx && ctx.mentionedJid) || [];
}

function getQuotedInfo(msg) {
  const ctx = getContextInfo(msg);
  if (!ctx || !ctx.quotedMessage) return null;
  return { stanzaId: ctx.stanzaId, participant: ctx.participant, message: ctx.quotedMessage };
}

const POLL_CREATION_TYPES = ["pollCreationMessage", "pollCreationMessageV2", "pollCreationMessageV3"];

function getWaMessageKind(msg) {
  const type = getMessageContentType(msg);
  if (type === "audioMessage") return msg.message.audioMessage.ptt ? "ptt" : "audio";
  if (type === "imageMessage") return "image";
  if (type === "videoMessage") return "video";
  if (type === "documentMessage") return "document";
  if (type === "stickerMessage") return "sticker";
  if (POLL_CREATION_TYPES.includes(type)) return "poll";
  return "text";
}

function formatWaPoll(msg) {
  const type = getMessageContentType(msg);
  if (!POLL_CREATION_TYPES.includes(type)) return null;
  const poll = msg.message[type];
  if (!poll) return null;

  const question = poll.name || "Sondage";
  const options  = (poll.options || []).map((o, i) => `${i + 1}. ${o.optionName}`).join("\n");
  const multi    = !poll.selectableOptionsCount || poll.selectableOptionsCount > 1;

  return `📊 *Sondage${multi ? " (choix multiples)" : ""} :* ${question}\n${options}`;
}

function extensionForKind(kind, msg) {
  const map = { image: "jpg", video: "mp4", document: "bin", sticker: "webp" };
  try {
    const type = getMessageContentType(msg);
    const content = msg.message[type];
    if (kind === "document" && content.fileName) {
      const ext = content.fileName.split(".").pop();
      if (ext) return ext;
    }
    if (content && content.mimetype) {
      const sub = content.mimetype.split("/")[1];
      if (sub) return sub.split(";")[0];
    }
  } catch (_) {}
  return map[kind] || "bin";
}

function rememberWaMessage(m) {
  if (m && m.key && m.key.id) waMessageStore.set(m.key.id, m);
}

function getSenderJid(msg) {
  return msg.key.participant || msg.key.remoteJid;
}

function getSenderName(msg) {
  const jid = getSenderJid(msg);
  const number = jid ? jid.split("@")[0] : "Inconnu";
  return contactNamesCache.get(jid) || msg.pushName || number;
}

async function downloadWaMedia(msg) {
  return downloadMediaMessage(msg, "buffer", {}, {
    logger: waLogger,
    reuploadRequest: sock.updateMediaMessage,
  });
}

// ==========================================================================
// HELPERS GENERAUX
// ==========================================================================

function saveMediaBuffer(buffer, ext) {
  const filename = `${Date.now()}.${ext}`;
  const filepath = `${MEDIA_DIR}/${filename}`;
  fs.writeFileSync(filepath, buffer);
  return { filename, filepath };
}

async function getDiscordChannel() {
  return discordClient.channels.fetch(DISCORD_CHANNEL_ID);
}

function friendlyWaErrorReply(e) {
  logError("Erreur WA (commande)", e);
  if (isFatalWaError(e.message)) {
    restartWaClient(`commande utilisateur: ${e.message}`);
    return "⚠️ WhatsApp semble déconnecté. Reconnexion automatique en cours, réessaie dans 10-15 secondes.";
  }
  return `❌ Erreur : ${e.message}`;
}

async function buildReplyPrefix(quotedDiscordId) {
  if (!quotedDiscordId) return "";
  try {
    const channel  = await getDiscordChannel();
    const original = await channel.messages.fetch(quotedDiscordId);
    const author   = original.author.username;
    const preview  = (original.content || "[MEDIA]").split("\n")[0].slice(0, 80);
    return `> **${author}** : ${preview}\n`;
  } catch (_) {
    return "";
  }
}

// ==========================================================================
// SYNC PHOTO DE PROFIL
// ==========================================================================

async function getContactAvatarUrl(jid) {
  if (avatarCache.has(jid)) return avatarCache.get(jid);
  try {
    const url = await sock.profilePictureUrl(jid, "image");
    avatarCache.set(jid, url || null);
    return url || null;
  } catch (_) {
    avatarCache.set(jid, null);
    return null;
  }
}

// ==========================================================================
// SYNC MENTIONS @ : WHATSAPP -> DISCORD
// ==========================================================================

async function convertWaMentionsToDiscord(text, mentionedJids) {
  if (!mentionedJids || mentionedJids.length === 0) return text;
  let result = text;

  for (const jid of mentionedJids) {
    const number = String(jid).split("@")[0];
    if (!number) continue;

    const mentionRegex = new RegExp(`@${number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
    const link = findLinkByWaNumber(number);

    if (link && link.discordId) {
      result = result.replace(mentionRegex, `<@${link.discordId}>`);
      continue;
    }

    const name  = contactNamesCache.get(jid) || number;
    const guild = await getCachedGuildMembers();

    const found = guild ? findGuildMemberByName(guild, name) : null;
    if (found) {
      result = result.replace(mentionRegex, `<@${found.id}>`);
      continue;
    }
    result = result.replace(mentionRegex, name);
  }

  return result;
}

// ==========================================================================
// SYNC MENTIONS @ : DISCORD -> WHATSAPP
// ==========================================================================

function convertDiscordMentionsToWa(content, mentionedUsers) {
  let result = content;
  const waMentionIds = [];
  if (!mentionedUsers || mentionedUsers.size === 0) return { text: result, mentions: waMentionIds };

  for (const [discordId] of mentionedUsers) {
    const link = findLinkByDiscordId(discordId);
    if (!link) continue;
    const waJid = `${link.waNumber}@s.whatsapp.net`;
    result = result.replace(new RegExp(`<@!?${discordId}>`, "g"), `@${link.waNumber}`);
    waMentionIds.push(waJid);
  }

  return { text: result, mentions: waMentionIds };
}

// ==========================================================================
// @everyone -> PING TOUT LE GROUPE WHATSAPP
// ==========================================================================

async function getAllGroupParticipantIds(group) {
  try {
    return (group.participants || []).map((p) => p.id);
  } catch (_) {
    return [];
  }
}

// ==========================================================================
// TRANSCRIPTION VOCALE (GROQ WHISPER)
// ==========================================================================

async function transcribeVoiceNote(filepath) {
  try {
    const form = new FormData();
    form.append("file", fs.createReadStream(filepath), {
      filename: "audio.ogg",
      contentType: "audio/ogg",
    });
    form.append("model", "whisper-large-v3");
    form.append("language", "fr");
    form.append("response_format", "json");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("Groq Whisper erreur :", err);
      return null;
    }

    const json = await res.json();
    return json.text || null;
  } catch (e) {
    logError("Erreur transcription Groq", e);
    return null;
  }
}

// ==========================================================================
// !txt : TRANSCRIPTION A LA DEMANDE (WhatsApp et Discord)
// ==========================================================================

async function sendWaReply(msg, text) {
  try {
    await sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
  } catch (e) {
    logError("Erreur sendWaReply", e);
  }
}

async function handleTxtCommandWa(msg) {
  try {
    const ctx = getContextInfo(msg);
    if (!ctx || !ctx.quotedMessage) {
      await sendWaReply(msg, "❌ Réponds à un message vocal avec !txt.");
      return;
    }

    const quotedType = getContentType(ctx.quotedMessage);
    if (quotedType !== "audioMessage") {
      await sendWaReply(msg, "❌ Le message cité n'est pas un message vocal.");
      return;
    }

    const quotedFakeMsg = {
      key: {
        remoteJid: msg.key.remoteJid,
        id: ctx.stanzaId,
        participant: ctx.participant,
        fromMe: ctx.participant ? undefined : msg.key.fromMe,
      },
      message: ctx.quotedMessage,
    };

    let buffer;
    try {
      buffer = await downloadWaMedia(quotedFakeMsg);
    } catch (e) {
      logError("Erreur getQuotedMessage (!txt WA)", e);
      await sendWaReply(msg, "❌ Impossible de récupérer le message vocal cité (lien expiré). Réessaie avec un vocal plus récent.");
      return;
    }

    if (!buffer) {
      await sendWaReply(msg, "❌ Impossible de télécharger l'audio (média expiré ou indisponible).");
      return;
    }

    const { filepath } = saveMediaBuffer(buffer, "ogg");
    await sendWaReply(msg, "⏳ Transcription en cours...");
    const transcript = await transcribeVoiceNote(filepath);

    await sendWaReply(
      msg,
      transcript
        ? `🎙️ *Transcription :*\n${transcript}`
        : "❌ Impossible de transcrire ce message vocal (voir logs serveur pour le détail Groq)."
    );
  } catch (e) {
    logError("Erreur !txt WA", e);
    await sendWaReply(msg, `❌ Erreur : ${e.message}`);
  }
}

async function handleTxtCommandDiscord(msg) {
  if (!msg.reference || !msg.reference.messageId) {
    await msg.reply("❌ Réponds à un message vocal (fichier audio) avec `!txt`.");
    return;
  }

  try {
    const channel  = await getDiscordChannel();
    const original = await channel.messages.fetch(msg.reference.messageId);
    const audioAtt = original.attachments.find((a) =>
      a.name && [".ogg", ".mp3", ".m4a", ".wav", ".webm"].some((ext) => a.name.endsWith(ext))
    );

    if (!audioAtt) {
      await msg.reply("❌ Aucun fichier audio trouvé dans ce message.");
      return;
    }

    await msg.reply("⏳ Transcription en cours...");
    const res      = await fetch(audioAtt.url);
    const buffer   = await res.buffer();
    const filepath = `${MEDIA_DIR}/${Date.now()}_${audioAtt.name}`;
    fs.writeFileSync(filepath, buffer);

    const transcript = await transcribeVoiceNote(filepath);
    await msg.reply(
      transcript
        ? `🎙️ **Transcription :**\n> ${transcript}`
        : "❌ Impossible de transcrire ce message vocal."
    );
  } catch (e) {
    logError("Erreur !txt Discord", e);
    await msg.reply(`❌ Erreur : ${e.message}`);
  }
}

async function handleTxtCommand(msg, source) {
  if (source === "wa") return handleTxtCommandWa(msg);
  if (source === "dc") return handleTxtCommandDiscord(msg);
}

// ==========================================================================
// SLASH COMMANDS : DEFINITION ET ENREGISTREMENT
// ==========================================================================

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Vérifie la latence du bot"),
  new SlashCommandBuilder().setName("status").setDescription("Etat de la connexion WhatsApp et du groupe sélectionné"),
  new SlashCommandBuilder().setName("groupes").setDescription("Liste les groupes WhatsApp disponibles"),
  new SlashCommandBuilder()
    .setName("select")
    .setDescription("Sélectionne un groupe WhatsApp")
    .addIntegerOption((opt) => opt.setName("numero").setDescription("Numéro du groupe (voir /groupes)").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("Affiche la liste des commandes disponibles"),
  new SlashCommandBuilder().setName("qr").setDescription("Force l'envoi (ou la régénération) du QR code de connexion WhatsApp"),
  new SlashCommandBuilder()
    .setName("connexion")
    .setDescription("Connecte WhatsApp sans QR code : reçois un code de couplage à entrer sur ton téléphone")
    .addStringOption((opt) => opt.setName("numero").setDescription("Numéro WhatsApp avec indicatif pays, ex: 33612345678").setRequired(true)),
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Lie ton pseudo Discord et ton numéro WhatsApp (sert à la sync des mentions @)")
    .addStringOption((opt) => opt.setName("pseudo").setDescription("Ton nom d'utilisateur Discord").setRequired(true))
    .addStringOption((opt) => opt.setName("numero").setDescription("Ton numéro WhatsApp (ex: 33612345678)").setRequired(true)),
].map((cmd) => cmd.toJSON());

async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    console.log("Enregistrement des slash commands...");
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: commands });
    console.log("Slash commands enregistrées.");
  } catch (e) {
    logError("Erreur enregistrement slash commands", e);
  }
}

// ==========================================================================
// DISCORD : READY
// ==========================================================================

discordClient.once("clientReady", async () => {
  console.log(`Discord connecté : ${discordClient.user.tag}`);
  await registerSlashCommands();
});

// ==========================================================================
// DISCORD : INTERACTIONS (SLASH COMMANDS)
// ==========================================================================

const HELP_TEXT_SLASH =
  "**Commandes slash :**\n" +
  "`/ping` — Latence du bot\n" +
  "`/groupes` — Liste les groupes WA\n" +
  "`/select <n>` — Sélectionne un groupe WA\n" +
  "`/status` — État de la connexion\n" +
  "`/qr` — Force la régénération et l'envoi du QR code de connexion WhatsApp\n" +
  "`/connexion <numero>` — Connecte WhatsApp sans QR : reçois un code de couplage en MP\n" +
  "`/link <pseudo> <numero>` — Lie ton pseudo Discord à ton numéro WhatsApp (sync des @)\n" +
  "`/help` — Cette aide\n\n" +
  "**Commandes `!` (Discord & WA) :**\n" +
  "`!txt` — Transcrit un message vocal (reply sur le vocal)\n" +
  "`!mute @Membre 2h` — Mute un membre (admins WA)\n" +
  "`!unmute @Membre` — Unmute un membre (admins WA)\n" +
  "`!groupes` / `!select <n>` / `!status` / `!help` — Commandes bridge\n\n" +
  "**Sondages :** un sondage créé sur Discord est recréé automatiquement comme vrai sondage WhatsApp, " +
  "et un sondage WhatsApp est relayé sur Discord sous forme de message (question + options).";

discordClient.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.channelId !== DISCORD_CHANNEL_ID) {
    try {
      await interaction.reply({ content: "❌ Utilise cette commande dans le bon salon.", ephemeral: true });
    } catch (_) {}
    return;
  }

  const { commandName } = interaction;

  const safeReply = async (payload) => {
    try {
      return interaction.deferred || interaction.replied
        ? await interaction.editReply(payload)
        : await interaction.reply(payload);
    } catch (e) {
      logError("Erreur reply interaction", e);
    }
  };

  if (commandName === "ping") {
    const latency = Date.now() - interaction.createdTimestamp;
    await safeReply(`🏓 Pong ! Latence : **${latency}ms** | WebSocket : **${discordClient.ws.ping}ms**`);
    return;
  }

  if (commandName === "help") {
    await safeReply(HELP_TEXT_SLASH);
    return;
  }

  if (commandName === "link") {
    try {
      const pseudo = interaction.options.getString("pseudo").trim();
      const numero = normalizeWaNumber(interaction.options.getString("numero"));

      if (!numero || numero.length < 8) {
        await safeReply({ content: "❌ Numéro WhatsApp invalide. Exemple : `33612345678`", ephemeral: true });
        return;
      }

      const guild = await getCachedGuildMembers();
      let discordId    = interaction.user.id;
      let resolvedName = pseudo;

      if (guild) {
        const found = findGuildMemberByName(guild, pseudo);
        if (found) {
          discordId    = found.id;
          resolvedName = found.user.username;
        }
      }

      setLink(discordId, resolvedName, numero);
      await safeReply({
        content: `✅ Lien créé : **${resolvedName}** ↔ **+${numero}**\nLes mentions \`@\` seront désormais correctement synchronisées entre Discord et WhatsApp.`,
        ephemeral: true,
      });
    } catch (e) {
      logError("Erreur /link", e);
      await safeReply({ content: `❌ Erreur : ${e.message}`, ephemeral: true });
    }
    return;
  }

  if (commandName === "qr") {
    if (waReady) {
      await safeReply("✅ WhatsApp est déjà connecté, pas besoin de QR code.\nSi tu veux quand même reconnecter avec un nouveau numéro, utilise `/qr` après avoir déconnecté l'appareil lié depuis WhatsApp > Appareils connectés.");
      return;
    }
    if (waRestartInProgress) {
      await safeReply("⏳ Le client WhatsApp est en cours de (re)démarrage, patiente quelques secondes et réessaie — le QR arrivera automatiquement s'il en faut un.");
      return;
    }
    await safeReply("🔄 Régénération du QR code en cours... il sera envoyé sur ce salon dans quelques secondes.");
    forceQrResend();
    return;
  }

  if (commandName === "connexion") {
    const numero = normalizeWaNumber(interaction.options.getString("numero"));
    if (!numero || numero.length < 8) {
      await safeReply({ content: "❌ Numéro invalide. Exemple : `33612345678` (indicatif pays + numéro, sans le `+` ni espaces).", ephemeral: true });
      return;
    }
    if (waReady) {
      await safeReply({ content: "✅ WhatsApp est déjà connecté, pas besoin de code de couplage.", ephemeral: true });
      return;
    }
    if (waRestartInProgress) {
      await safeReply({ content: "⏳ Le client WhatsApp est en cours de (re)démarrage, patiente quelques secondes et réessaie.", ephemeral: true });
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      logError("Erreur deferReply /connexion", e);
      return;
    }

    try {
      const code = await sock.requestPairingCode(numero);
      try {
        await interaction.user.send(
          `🔑 Ton code de couplage WhatsApp : **${code}**\n\n` +
          "Sur ton téléphone : ouvre **WhatsApp** > *Réglages* > *Appareils connectés* > *Lier un appareil* > " +
          "**« Lier avec le numéro de téléphone à la place »** > entre ce code.\n" +
          "⏱️ Il expire au bout de quelques minutes, fais vite."
        );
        await safeReply({ content: "✅ Le code de couplage t'a été envoyé en message privé." });
      } catch (dmError) {
        await safeReply({ content: `❌ Impossible de t'envoyer un MP (vérifie que tes messages privés sont ouverts pour ce serveur). Ton code : **${code}**` });
      }
    } catch (e) {
      logError("Erreur /connexion (requestPairingCode)", e);
      await safeReply({ content: `❌ Erreur lors de la génération du code : ${e.message}` });
    }
    return;
  }

  try {
    await interaction.deferReply();
  } catch (e) {
    logError("Erreur deferReply", e);
    return;
  }

  if (commandName === "status") {
    try {
      const group = await getSelectedGroup();
      await safeReply(
        waReady
          ? `✅ WhatsApp connecté\n📌 Groupe : **${group ? group.name : "aucun sélectionné"}**`
          : "❌ WhatsApp non connecté"
      );
    } catch (e) {
      logError("Erreur /status", e);
      await safeReply(`❌ Erreur : ${e.message}`);
    }
    return;
  }

  if (commandName === "groupes") {
    if (!waReady) {
      await safeReply("⏳ WhatsApp n'est pas encore prêt (session en cours d'initialisation). Réessaie dans quelques secondes, ou utilise `/status` pour vérifier.");
      return;
    }
    try {
      const groups = await getWaGroups();
      if (!groups.length) {
        await safeReply("Aucun groupe trouvé.");
        return;
      }
      const txt = "**Groupes disponibles :**\n" +
        groups.map((g, i) => `\`${i + 1}.\` ${g.name}`).join("\n");
      await safeReply(txt);
    } catch (e) {
      await safeReply(friendlyWaErrorReply(e));
    }
    return;
  }

  if (commandName === "select") {
    if (!waReady) {
      await safeReply("⏳ WhatsApp n'est pas encore prêt (session en cours d'initialisation). Réessaie dans quelques secondes, ou utilise `/status` pour vérifier.");
      return;
    }
    try {
      const index  = interaction.options.getInteger("numero") - 1;
      const groups = await getWaGroups();
      if (Number.isNaN(index) || !groups[index]) {
        await safeReply("❌ Numéro invalide. Utilise `/groupes`.");
        return;
      }
      selectedGroupId = groups[index].id._serialized;
      saveSelectedGroup();
      invalidateGroupCache();
      await safeReply(`✅ Groupe sélectionné : **${groups[index].name}**`);
    } catch (e) {
      await safeReply(friendlyWaErrorReply(e));
    }
    return;
  }
});

// ==========================================================================
// WHATSAPP (BAILEYS) : CONNEXION / QR / RECONNEXION
// ==========================================================================

async function startWaSocket() {
  waRestartInProgress = true;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: waLogger,
    browser: ["Bridge Discord-WA", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      if (c.id && (c.name || c.notify)) contactNamesCache.set(c.id, c.name || c.notify);
    }
  });
  sock.ev.on("contacts.update", (contacts) => {
    for (const c of contacts) {
      if (c.id && (c.name || c.notify)) contactNamesCache.set(c.id, c.name || c.notify);
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      waRestartInProgress = false;
      try {
        console.log("QR code reçu, génération en cours...");
        const dataUrl = await qrcode.toDataURL(qr);
        const base64  = dataUrl.replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync("qr.png", base64, "base64");
        const channel = await getDiscordChannel();
        await channel.send({ content: "Scanne ce QR code pour connecter WhatsApp", files: ["qr.png"] });
        console.log("QR code envoyé sur Discord.");
      } catch (e) {
        logError("Erreur QR", e);
      }
    }

    if (connection === "open") {
      console.log("WhatsApp connecté");
      waRestartInProgress = false;
      await new Promise((r) => setTimeout(r, 5000));
      startTimestamp = Math.floor(Date.now() / 1000);
      waReady = true;
      console.log("WhatsApp prêt");
    }

    if (connection === "close") {
      waReady = false;
      invalidateGroupCache();

      const statusCode = lastDisconnect && lastDisconnect.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : null;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.warn("WhatsApp déconnecté, code :", statusCode);

      try {
        const channel = await getDiscordChannel();
        await channel.send(
          loggedOut
            ? "⚠️ Session WhatsApp déconnectée (logout depuis le téléphone). Utilise `/qr` ou `/connexion` pour reconnecter."
            : "⚠️ Le pont WhatsApp a rencontré un problème et se reconnecte automatiquement..."
        );
      } catch (_) {}

      if (loggedOut) {
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
        waRestartInProgress = false;
      } else {
        setTimeout(() => {
          startWaSocket().catch((e) => {
            logError("Erreur reconnexion WA", e);
            waRestartInProgress = false;
          });
        }, 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        await handleIncomingWaMessage(m);
      } catch (e) {
        logError("Erreur traitement message WA", e);
      }
    }
  });

  return sock;
}

// ==========================================================================
// WHATSAPP -> DISCORD
// ==========================================================================

async function handleIncomingWaMessage(msg) {
  if (!waReady) return;
  if (!msg.message) return;

  const jid = msg.key.remoteJid;
  if (!jid || !jid.endsWith("@g.us")) return;
  if (selectedGroupId && jid !== selectedGroupId) return;

  const ts = Number(msg.messageTimestamp || 0);
  if (ts < startTimestamp) return;

  // Editions / suppressions (protocolMessage)
  const contentType = getMessageContentType(msg);
  if (contentType === "protocolMessage") {
    await handleWaProtocolMessage(msg);
    return;
  }

  const waId = msg.key.id;
  rememberWaMessage(msg);

  if (sentByBridge.has(waId)) {
    sentByBridge.delete(waId);
    return;
  }

  // Messages envoyés depuis le téléphone lié lui-même (fromMe) :
  // uniquement !txt est traité, comme dans la version whatsapp-web.js.
  if (msg.key.fromMe) {
    const rawText = extractText(msg).trim();
    if (rawText === "!txt") {
      sentByBridge.add(waId);
      await handleTxtCommand(msg, "wa");
    }
    return;
  }

  const senderJid = getSenderJid(msg);
  const name      = getSenderName(msg);
  const rawText   = extractText(msg);
  const group     = await getSelectedGroup();

  if (rawText.trim() === "!txt") {
    await handleTxtCommand(msg, "wa");
    return;
  }

  if (group && rawText.startsWith("!mute ")) {
    await handleMuteCommand(msg, group, senderJid, name, waId, rawText);
    return;
  }

  if (group && rawText.startsWith("!unmute ")) {
    await handleUnmuteCommand(msg, group, senderJid, name, waId);
    return;
  }

  if (isMuted(senderJid)) {
    log("MUTE_BLOCK", name, "Message supprimé (mute actif)");
    try { await sock.sendMessage(jid, { delete: msg.key }); } catch (e) { logError("Erreur suppression message mute", e); }
    return;
  }

  await relayWaMessageToDiscord(msg, senderJid, name, rawText, waId);
}

async function handleWaProtocolMessage(msg) {
  const proto_ = msg.message.protocolMessage;
  if (!proto_) return;
  const jid = msg.key.remoteJid;
  if (selectedGroupId && jid !== selectedGroupId) return;

  const ProtoType = proto.Message.ProtocolMessage.Type;

  if (proto_.type === ProtoType.MESSAGE_EDIT) {
    const originalId = proto_.key && proto_.key.id;
    if (!originalId) return;
    const discordId = waToDiscord.get(originalId);
    if (!discordId) return;
    const newText = proto_.editedMessage ? extractText({ message: proto_.editedMessage }) : "";
    try {
      const senderJid = msg.key.participant || jid;
      const name = contactNamesCache.get(senderJid) || (senderJid ? senderJid.split("@")[0] : "Inconnu");
      await webhook.editMessage(discordId, { content: `${name} : ${newText || "[MEDIA]"} *(édité)*` });
    } catch (e) {
      if (!e.message.includes("Unknown Message")) logError("Erreur édition WA->DC", e);
    }
    return;
  }

  if (proto_.type === ProtoType.REVOKE) {
    const originalId = proto_.key && proto_.key.id;
    if (!originalId) return;
    const discordId = waToDiscord.get(originalId);
    if (!discordId) return;
    try {
      await webhook.deleteMessage(discordId);
    } catch (e) {
      if (!e.message.includes("Unknown Message")) logError("Erreur suppression WA->DC", e);
    }
    return;
  }
}

async function handleMuteCommand(msg, group, senderJid, name, waId, rawText) {
  const adminCheck = isGroupAdmin(senderJid, group);
  if (!adminCheck) {
    await group.sendMessage("❌ Seuls les admins peuvent utiliser !mute.", { quotedMessageId: waId });
    return;
  }

  const parts       = rawText.trim().split(/\s+/);
  const durationStr = parts[parts.length - 1];
  const durationMs  = parseDuration(durationStr);
  if (!durationMs) {
    await group.sendMessage(
      "❌ Format invalide. Exemple : `!mute @Personne 2d`\nUnités : m (minutes), h (heures), d (jours)",
      { quotedMessageId: waId }
    );
    return;
  }

  const targetJid = resolveMentionedJid(msg);
  if (!targetJid) {
    await group.sendMessage("❌ Mentionne un membre avec @.", { quotedMessageId: waId });
    return;
  }

  const targetName    = contactNamesCache.get(targetJid) || targetJid.split("@")[0];
  const targetIsAdmin = isGroupAdmin(targetJid, group);
  if (targetIsAdmin) {
    await group.sendMessage("❌ Impossible de muter un admin du groupe.", { quotedMessageId: waId });
    return;
  }

  const expireAt = Date.now() + durationMs;
  mutedUsers[targetJid] = expireAt;
  saveMutes();
  log("MUTE", name, `${targetName} muté jusqu'au ${formatExpire(expireAt)}`);

  await group.sendMessage(
    `🔇 *${targetName}* est mute jusqu'au *${formatExpire(expireAt)}*.\n` +
    "Ses messages seront automatiquement supprimés.\n" +
    `Un admin peut le démuter avec \`!unmute @${targetName}\`.`,
    { quotedMessageId: waId }
  );
}

async function handleUnmuteCommand(msg, group, senderJid, name, waId) {
  const adminCheck = isGroupAdmin(senderJid, group);
  if (!adminCheck) {
    await group.sendMessage("❌ Seuls les admins peuvent utiliser !unmute.", { quotedMessageId: waId });
    return;
  }

  const targetJid = resolveMentionedJid(msg);
  if (!targetJid) {
    await group.sendMessage("❌ Mentionne un membre avec @.", { quotedMessageId: waId });
    return;
  }

  const targetName = contactNamesCache.get(targetJid) || targetJid.split("@")[0];

  if (mutedUsers[targetJid]) {
    delete mutedUsers[targetJid];
    saveMutes();
    log("UNMUTE", name, `${targetName} démuté par ${name}`);
    await group.sendMessage(
      `🔊 *${targetName}* a été démuté par *${name}*.\nIl peut de nouveau envoyer des messages.`,
      { quotedMessageId: waId }
    );
  } else {
    await group.sendMessage(`ℹ️ *${targetName}* n'est pas mute.`, { quotedMessageId: waId });
  }
}

async function relayWaMessageToDiscord(msg, senderJid, name, rawText, waId) {
  const avatarUrl     = await getContactAvatarUrl(senderJid);
  const mentionedJids = getMentionedJids(msg);

  let text = rawText;
  if (mentionedJids.length > 0) {
    text = await convertWaMentionsToDiscord(text, mentionedJids);
  }

  const kind = getWaMessageKind(msg);

  if (kind === "poll") {
    const pollText = formatWaPoll(msg) || "📊 Sondage WhatsApp";
    log("WA->DC", name, "[SONDAGE] " + pollText.replace(/\n/g, " | "));
    const webhookOptions = { username: name, content: pollText };
    if (avatarUrl) webhookOptions.avatarURL = avatarUrl;
    const sent = await webhook.send(webhookOptions);
    waToDiscord.set(waId, sent.id);
    discordToWa.set(sent.id, waId);
    return;
  }

  if (kind === "ptt" || kind === "audio") {
    try {
      const buffer = await downloadWaMedia(msg);
      if (buffer) {
        const { filename, filepath } = saveMediaBuffer(buffer, extensionForKind(kind, msg));
        const transcript = await transcribeVoiceNote(filepath);

        const webhookOptions = {
          username: name,
          content: transcript
            ? `🎙️ *Message vocal :*\n> ${transcript}`
            : "🎙️ *Message vocal* — réponds avec `!txt` pour transcrire",
          files: [{ attachment: filepath, name: filename }],
        };
        if (avatarUrl) webhookOptions.avatarURL = avatarUrl;

        const sent = await webhook.send(webhookOptions);
        waToDiscord.set(waId, sent.id);
        discordToWa.set(sent.id, waId);
      }
    } catch (e) {
      logError("Erreur message vocal WA->DC", e);
    }
    return;
  }

  const files = [];
  const hasMedia = ["image", "video", "document", "sticker"].includes(kind);
  if (hasMedia) {
    try {
      const buffer = await downloadWaMedia(msg);
      if (buffer) {
        if (buffer.length > MAX_DISCORD_FILE_SIZE) {
          log("MEDIA_SKIP", name, `Fichier trop lourd (${Math.round(buffer.length / 1024 / 1024)} MB)`);
        } else {
          const { filename, filepath } = saveMediaBuffer(buffer, extensionForKind(kind, msg));
          files.push({ attachment: filepath, name: filename });
        }
      }
    } catch (e) {
      logError("Erreur media WA->DC", e);
    }
  }

  let replyPrefix = "";
  const quoted = getQuotedInfo(msg);
  if (quoted && quoted.stanzaId) {
    const quotedDiscordId = waToDiscord.get(quoted.stanzaId);
    replyPrefix = await buildReplyPrefix(quotedDiscordId);
  }

  const finalContent = replyPrefix + (text || "");
  if (!finalContent.trim() && files.length === 0) return;

  log("WA->DC", name, rawText || "[MEDIA]");

  const webhookOptions = { username: name, content: finalContent || " ", files };
  if (avatarUrl) webhookOptions.avatarURL = avatarUrl;

  const sent = await webhook.send(webhookOptions);
  waToDiscord.set(waId, sent.id);
  discordToWa.set(sent.id, waId);
}

// ==========================================================================
// DISCORD -> WHATSAPP : ENVOI DE MEDIAS
// ==========================================================================

async function buildWaMediaPayload(url, filename, caption) {
  const res         = await fetch(url);
  const buffer      = await res.buffer();
  const contentType = res.headers.get("content-type") || "";
  const ext         = (filename.split(".").pop() || "").toLowerCase();

  if (contentType.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif"].includes(ext)) {
    return { image: buffer, caption };
  }
  if (contentType.startsWith("video/") || ["mp4", "mov", "webm"].includes(ext)) {
    return { video: buffer, caption };
  }
  if (contentType.startsWith("audio/") || ["ogg", "mp3", "m4a", "wav"].includes(ext)) {
    return { audio: buffer, mimetype: contentType || "audio/mpeg", ptt: false };
  }
  return { document: buffer, fileName: filename, mimetype: contentType || "application/octet-stream", caption };
}

async function handleDiscordBangCommands(message, content) {
  if (content === "!groupes") {
    if (!waReady) {
      await message.reply("⏳ WhatsApp n'est pas encore prêt (session en cours d'initialisation). Réessaie dans quelques secondes.");
      return true;
    }
    try {
      const groups = await getWaGroups();
      if (!groups.length) {
        await message.reply("Aucun groupe trouvé.");
      } else {
        const txt = "Groupes disponibles :\n" + groups.map((g, i) => `${i + 1}. ${g.name}`).join("\n");
        await message.reply(txt);
      }
    } catch (e) {
      await message.reply(friendlyWaErrorReply(e));
    }
    return true;
  }

  if (content.startsWith("!select ")) {
    if (!waReady) {
      await message.reply("⏳ WhatsApp n'est pas encore prêt (session en cours d'initialisation). Réessaie dans quelques secondes.");
      return true;
    }
    try {
      const index  = parseInt(content.split(" ")[1], 10) - 1;
      const groups = await getWaGroups();
      if (Number.isNaN(index) || !groups[index]) {
        await message.reply("Numéro invalide. Utilise /groupes.");
      } else {
        selectedGroupId = groups[index].id._serialized;
        saveSelectedGroup();
        invalidateGroupCache();
        await message.reply(`Groupe sélectionné : ${groups[index].name}`);
      }
    } catch (e) {
      await message.reply(friendlyWaErrorReply(e));
    }
    return true;
  }

  if (content === "!status") {
    try {
      const group = await getSelectedGroup();
      await message.reply(
        waReady ? `WhatsApp connecté\nGroupe : ${group ? group.name : "aucun sélectionné"}` : "WhatsApp non connecté"
      );
    } catch (e) {
      logError("Erreur !status", e);
    }
    return true;
  }

  if (content === "!qr") {
    if (waReady) {
      await message.reply("✅ WhatsApp est déjà connecté, pas besoin de QR code.");
    } else if (waRestartInProgress) {
      await message.reply("⏳ Le client WhatsApp est en cours de (re)démarrage, patiente quelques secondes et réessaie.");
    } else {
      await message.reply("🔄 Régénération du QR code en cours... il sera envoyé sur ce salon dans quelques secondes.");
      forceQrResend();
    }
    return true;
  }

  if (content.startsWith("!connexion ")) {
    await handleBangConnexion(message, content);
    return true;
  }

  if (content === "!help") {
    await message.reply(
      "Commandes disponibles :\n" +
      "`!txt` — Transcrit un message vocal (reply sur le message audio)\n" +
      "`!groupes` — Liste les groupes WA\n" +
      "`!select <n>` — Sélectionne un groupe WA\n" +
      "`!status` — Etat connexion\n" +
      "`!qr` — Force l'envoi du QR code de connexion WhatsApp\n" +
      "`!connexion <numero>` — Connecte WhatsApp sans QR : reçois un code de couplage en MP\n" +
      "`!help` — Cette aide\n" +
      "Slash : `/ping` `/groupes` `/select` `/status` `/link` `/qr` `/connexion` `/help`"
    );
    return true;
  }

  return false;
}

async function handleBangConnexion(message, content) {
  const numero = normalizeWaNumber(content.split(" ")[1] || "");
  if (!numero || numero.length < 8) {
    await message.reply("❌ Numéro invalide. Exemple : `!connexion 33612345678` (indicatif pays + numéro, sans le `+` ni espaces).");
    return;
  }
  if (waReady) {
    await message.reply("✅ WhatsApp est déjà connecté, pas besoin de code de couplage.");
    return;
  }
  if (waRestartInProgress) {
    await message.reply("⏳ Le client WhatsApp est en cours de (re)démarrage, patiente quelques secondes et réessaie.");
    return;
  }

  try {
    const code = await sock.requestPairingCode(numero);
    try {
      await message.author.send(
        `🔑 Ton code de couplage WhatsApp : **${code}**\n\n` +
        "Sur ton téléphone : ouvre **WhatsApp** > *Réglages* > *Appareils connectés* > *Lier un appareil* > " +
        "**« Lier avec le numéro de téléphone à la place »** > entre ce code.\n" +
        "⏱️ Il expire au bout de quelques minutes, fais vite."
      );
      await message.reply("✅ Le code de couplage t'a été envoyé en message privé.");
    } catch (dmError) {
      await message.reply(`❌ Impossible de t'envoyer un MP (vérifie que tes messages privés sont ouverts). Ton code : **${code}**`);
    }
  } catch (e) {
    logError("Erreur !connexion (requestPairingCode)", e);
    await message.reply(`❌ Erreur lors de la génération du code : ${e.message}`);
  }
}

async function relayDiscordPollToWa(message, group, name) {
  try {
    const poll = message.poll;
    const question = poll.question && poll.question.text ? poll.question.text : "Sondage";
    const answers = Array.from(poll.answers.values())
      .map((a) => (a.text || "Option").trim())
      .filter(Boolean)
      .slice(0, 12); // limite WhatsApp

    if (answers.length < 2) {
      log("DC->WA_ERROR", name, "Sondage ignoré (moins de 2 options valides)");
      return;
    }

    const selectableCount = poll.allowMultiselect ? answers.length : 1;
    const sent = await group.sendMessage({
      poll: { name: `${name} : ${question}`, values: answers, selectableCount },
    }, {});

    if (sent) {
      sentByBridge.add(sent.key.id);
      waToDiscord.set(sent.key.id, message.id);
      discordToWa.set(message.id, sent.key.id);
      log("DC->WA", name, `[SONDAGE] ${question}`);
    } else {
      log("DC->WA_FAIL", name, `Sondage non envoyé : ${question}`);
    }
  } catch (e) {
    log("DC->WA_ERROR", name, `ERREUR sondage: ${e.message}`);
    logError("Erreur relayDiscordPollToWa", e);
  }
}

async function relayDiscordMessageToWa(message, group, name, content) {
  const replyOptions = {};
  if (message.reference && message.reference.messageId) {
    const quotedWaId = discordToWa.get(message.reference.messageId);
    if (quotedWaId) replyOptions.quotedMessageId = quotedWaId;
  }

  if (content && content.includes("@here")) {
    log("DC->WA_BLOCKED", name, `Message ignoré (contient @here) : ${content}`);
    return;
  }

  if (content && !content.startsWith("!")) {
    try {
      let { text: waContent, mentions } = convertDiscordMentionsToWa(content, message.mentions.users);

      if (content.includes("@everyone")) {
        const allIds  = await getAllGroupParticipantIds(group);
        const pingIds = allIds.filter((id) => id.endsWith("@s.whatsapp.net") || id.endsWith("@lid"));
        const pingTags = pingIds.map((id) => `@${id.split("@")[0]}`).join(" ");
        waContent = waContent.replace(/@everyone/g, `@all ${pingTags}`);
        mentions  = Array.from(new Set([...mentions, ...pingIds]));
      }

      const sendOptions = { ...replyOptions, ...(mentions.length ? { mentions } : {}) };
      const sent = await group.sendMessage(`*${name}* : ${waContent}`, sendOptions);

      if (sent) {
        sentByBridge.add(sent.key.id);
        waToDiscord.set(sent.key.id, message.id);
        discordToWa.set(message.id, sent.key.id);
        log("DC->WA", name, waContent);
      } else {
        log("DC->WA_FAIL", name, `sendMessage retourne null | msg: ${content}`);
      }
    } catch (e) {
      log("DC->WA_ERROR", name, `ERREUR: ${e.message} | msg: ${content}`);
      logError("Erreur relayDiscordMessageToWa (texte)", e);
    }
  }

  for (const att of message.attachments.values()) {
    try {
      const payload = await buildWaMediaPayload(att.url, att.name, `*${name}*`);
      const sent    = await group.sendMessage(payload, replyOptions);

      if (sent) {
        sentByBridge.add(sent.key.id);
        waToDiscord.set(sent.key.id, message.id);
        discordToWa.set(message.id, sent.key.id);
        log("DC->WA", name, `[MEDIA] ${att.name}`);
      } else {
        log("DC->WA_FAIL", name, `sendMessage media retourne null | fichier: ${att.name}`);
      }
    } catch (e) {
      log("DC->WA_ERROR", name, `ERREUR media: ${e.message} | fichier: ${att.name}`);
      logError("Erreur relayDiscordMessageToWa (media)", e);
    }
  }
}

// ==========================================================================
// DISCORD : EDITION / SUPPRESSION -> WHATSAPP
// ==========================================================================

discordClient.on("messageUpdate", async (_, newMessage) => {
  if (newMessage.author && newMessage.author.bot) return;
  if (newMessage.channel.id !== DISCORD_CHANNEL_ID) return;

  const waId = discordToWa.get(newMessage.id);
  if (!waId) return;

  const stored = waMessageStore.get(waId);
  if (!stored) return;

  try {
    await sock.sendMessage(stored.key.remoteJid, { text: newMessage.content, edit: stored.key });
  } catch (e) {
    logError("Erreur édition DC->WA", e);
  }
});

discordClient.on("messageDelete", async (message) => {
  if (message.channel.id !== DISCORD_CHANNEL_ID) return;

  const waId = discordToWa.get(message.id);
  if (!waId) return;

  const stored = waMessageStore.get(waId);
  if (!stored) return;

  try {
    await sock.sendMessage(stored.key.remoteJid, { delete: stored.key });
  } catch (e) {
    logError("Erreur suppression DC->WA", e);
  }
});

// ==========================================================================
// DISCORD : MESSAGES -> WHATSAPP
// ==========================================================================

discordClient.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.webhookId) return;
  if (message.interaction || message.interactionMetadata) return;
  if (message.applicationId) return;
  if (message.channel.id !== DISCORD_CHANNEL_ID) return;
  if (!waReady) return;
  if (message.content && message.content.startsWith("/")) return;

  const name    = message.member ? message.member.displayName : message.author.username;
  const content = message.content;

  if (message.poll) {
    const group = await getSelectedGroup();
    if (!group) {
      await message.reply("Aucun groupe sélectionné. Utilise `/select <n>`.");
      return;
    }
    await relayDiscordPollToWa(message, group, name);
    return;
  }

  if (content.trim() === "!txt") {
    await handleTxtCommand(message, "dc");
    return;
  }

  if (await handleDiscordBangCommands(message, content)) return;

  const group = await getSelectedGroup();
  if (!group) {
    await message.reply("Aucun groupe sélectionné. Utilise `/select <n>`.");
    return;
  }

  await relayDiscordMessageToWa(message, group, name, content);
});

// ==========================================================================
// DEMARRAGE
// ==========================================================================

loadSelectedGroup();
loadLinks();
loadMutes();

discordClient.login(DISCORD_TOKEN)
  .then(() => console.log("Connexion Discord lancée"))
  .catch((e) => logError("Erreur connexion Discord", e));

startWaSocket().catch((e) => {
  logError("Erreur initialisation WA", e);
  waRestartInProgress = false;
});