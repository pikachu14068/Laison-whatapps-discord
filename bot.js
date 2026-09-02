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
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const {
  default: makeWASocket,
  initAuthCreds,
  BufferJSON,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  getContentType,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers,
  proto,
} = require("@whiskeysockets/baileys");
const NodeCache = require("node-cache");
const { execSync } = require("child_process");

function logTimestamp() {
  return new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
}
const rawConsoleLog   = console.log.bind(console);
const rawConsoleWarn  = console.warn.bind(console);
const rawConsoleError = console.error.bind(console);
console.log   = (...args) => rawConsoleLog(`[${logTimestamp()}]`, ...args);
console.warn  = (...args) => rawConsoleWarn(`[${logTimestamp()}]`, ...args);
console.error = (...args) => rawConsoleError(`[${logTimestamp()}]`, ...args);

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
    console.error(`Variable d'environnement manquante : ${key}. Verifie ton fichier .env.`);
    process.exit(1);
  }
}

const MEDIA_DIR  = "./media";
const LOG_FILE   = "./bridge.log";
const MUTES_FILE = "./mutes.json";
const GROUP_FILE = "./selected_group.json";
const LINKS_FILE = "./links.json";
const AUTH_DIR        = "./wa_auth";
const AUTH_BACKUP_DIR  = "./wa_auth_backup";
const LOCK_FILE        = "./bot.lock";
const UPDATE_STATE_FILE = "./update_state.json";

const GUILD_MEMBERS_CACHE_TTL = 60 * 1000;
const GROUP_CACHE_TTL         = 60 * 1000;
const MAX_DISCORD_FILE_SIZE   = 8 * 1024 * 1024;

const waLogger = pino({ level: "silent" });

class BoundedMap extends Map {
  constructor(maxSize) {
    super();
    this.maxSize = maxSize;
  }
  set(key, value) {
    if (this.size >= this.maxSize && !this.has(key)) {
      const oldestKey = this.keys().next().value;
      this.delete(oldestKey);
    }
    return super.set(key, value);
  }
}

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

const waToDiscord      = new BoundedMap(5000);
const discordToWa      = new BoundedMap(5000);
const sentByBridge      = new Set();
const avatarCache       = new BoundedMap(2000);
const contactSavedNameCache  = new Map();
const contactNotifyNameCache = new Map();
const waMessageStore    = new BoundedMap(3000);

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

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireSingleInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
      if (oldPid && oldPid !== process.pid && isProcessAlive(oldPid)) {
        console.error(
          `ARRET : une autre instance du bot tourne deja (PID ${oldPid}). ` +
          "Faire tourner deux instances sur la meme session WhatsApp corrompt la " +
          "session et force des reconnexions/QR reguliers. Verifie 'pm2 list' ou " +
          "'ps aux | grep bot.js', tue le doublon, puis relance."
        );
        process.exit(1);
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (e) {
    logError("Erreur verrou instance unique", e);
  }
}

function releaseSingleInstanceLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const owner = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
      if (owner === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch (_) {}
}

const AUTH_BACKUP_INTERVAL_MS = 30 * 60 * 1000;
let authBackupInterval = null;
let badSessionRestoreAttempted = false;

function backupAuthState() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    const tmpDir = AUTH_BACKUP_DIR + ".tmp";
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.cpSync(AUTH_DIR, tmpDir, {
      recursive: true,
      filter: (src) => !src.includes(".tmp-"),
    });

    if (fs.existsSync(AUTH_BACKUP_DIR)) fs.rmSync(AUTH_BACKUP_DIR, { recursive: true, force: true });
    fs.renameSync(tmpDir, AUTH_BACKUP_DIR);
  } catch (e) {
    logError("Erreur sauvegarde session WA", e);
  }
}

function restoreAuthBackup() {
  try {
    if (!fs.existsSync(AUTH_BACKUP_DIR)) return false;
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.cpSync(AUTH_BACKUP_DIR, AUTH_DIR, { recursive: true });
    console.log("Session WhatsApp restauree depuis la derniere sauvegarde connue-bonne.");
    return true;
  } catch (e) {
    logError("Erreur restauration session WA", e);
    return false;
  }
}

function startAuthBackupSchedule() {
  if (authBackupInterval) clearInterval(authBackupInterval);

  setTimeout(backupAuthState, 15000);
  authBackupInterval = setInterval(backupAuthState, AUTH_BACKUP_INTERVAL_MS);
}

const fileWriteQueues = new Map();

function queueFileWrite(filePath, task) {
  const previous = fileWriteQueues.get(filePath) || Promise.resolve();
  const next = previous.then(task, task);
  fileWriteQueues.set(filePath, next);



  next.finally(() => {
    if (fileWriteQueues.get(filePath) === next) fileWriteQueues.delete(filePath);
  }).catch(() => {});
  return next;
}

async function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const json = JSON.stringify(data, BufferJSON.replacer);
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    await fs.promises.rename(tmpPath, filePath);
  } catch (e) {
    try { await fs.promises.unlink(tmpPath); } catch (_) {}
    throw e;
  }
}

function fixAuthFileName(file) {
  return file.replace(/\//g, "__");
}

function cleanupOrphanAuthTmpFiles(folder) {
  try {
    if (!fs.existsSync(folder)) return;
    for (const f of fs.readdirSync(folder)) {
      if (f.includes(".tmp-")) {
        try { fs.unlinkSync(`${folder}/${f}`); } catch (_) {}
      }
    }
  } catch (e) {
    logError("Erreur nettoyage fichiers temporaires auth", e);
  }
}

async function useHardenedMultiFileAuthState(folder) {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  cleanupOrphanAuthTmpFiles(folder);

  const pathFor = (file) => `${folder}/${fixAuthFileName(file)}`;

  const readAuthData = async (file) => {
    try {
      const raw = await fs.promises.readFile(pathFor(file), "utf-8");
      return JSON.parse(raw, BufferJSON.reviver);
    } catch (e) {
      if (e.code !== "ENOENT") {
        logError(`Cle de session illisible (${file}), traitee comme absente`, e);
      }
      return null;
    }
  };

  const writeAuthData = (file, data) => {
    const filePath = pathFor(file);
    return queueFileWrite(filePath, () => atomicWriteJson(filePath, data));
  };

  const removeAuthData = (file) => {
    const filePath = pathFor(file);
    return queueFileWrite(filePath, async () => {
      try { await fs.promises.unlink(filePath); } catch (_) {}
    });
  };

  const creds = (await readAuthData("creds.json")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readAuthData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeAuthData(file, value) : removeAuthData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeAuthData("creds.json", creds),
  };
}

let waRestartInProgress   = false;
let reconnectAttempts     = 0;
let reconnectTimer        = null;
let discordNotifiedThisCycle = false;

const RECONNECT_BASE_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS  = 60000;

function clearPendingReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function computeBackoffDelay() {
  const raw    = RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempts);
  const capped = Math.min(raw, RECONNECT_MAX_DELAY_MS);
  const jitter = Math.random() * 1000;
  return capped + jitter;
}

async function withRetry(fn, { attempts = 3, delayMs = 4000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        console.warn(`Tentative ${i + 1}/${attempts} echouee (${e.message}), nouvel essai dans ${delayMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

async function notifyDiscordOnce(text) {
  if (discordNotifiedThisCycle) return;
  discordNotifiedThisCycle = true;
  try {
    await withRetry(async () => {
      const channel = await getDiscordChannel();
      await channel.send(text);
    });
  } catch (_) {}
}

function scheduleReconnect(reason, { immediate = false, clearSession = false } = {}) {
  clearPendingReconnect();
  waRestartInProgress = true;
  waReady = false;
  invalidateGroupCache();

  if (clearSession) {
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });


      fs.rmSync(AUTH_BACKUP_DIR, { recursive: true, force: true });
    } catch (e) {
      logError("Erreur suppression session pendant reconnexion", e);
    }
    reconnectAttempts = 0;
  }

  const delay = immediate ? 500 : computeBackoffDelay();
  reconnectAttempts += 1;

  console.warn(
    `Reconnexion WhatsApp programmee dans ${Math.round(delay / 1000)}s (tentative #${reconnectAttempts}) - raison : ${reason}`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWaSocket().catch((e) => {
      logError("Erreur reinitialisation du client WA", e);
      waRestartInProgress = false;


      scheduleReconnect(`echec startWaSocket: ${e.message}`);
    });
  }, delay);
}

function requestWaSocketEnd(reason) {
  if (waRestartInProgress) {
    console.log(`Fin de socket ignoree (reconnexion deja en cours) : ${reason}`);
    return;
  }
  console.error(`Fin du socket WhatsApp demandee : ${reason}`);
  try {
    if (sock) {
      sock.end(new Error(reason));
    } else {

      scheduleReconnect(reason);
    }
  } catch (e) {
    logError("Erreur end() pendant la demande de reconnexion", e);
    scheduleReconnect(reason);
  }
}

async function forceQrResend() {
  if (waRestartInProgress) {
    console.log("Regeneration QR ignoree : un redemarrage est deja en cours.");
    return;
  }
  clearPendingReconnect();
  waRestartInProgress = true;
  waReady = false;
  reconnectAttempts = 0;
  discordNotifiedThisCycle = true;
  invalidateGroupCache();
  console.log("Regeneration manuelle du QR code demandee (/qr ou !qr).");

  try {
    if (sock) await sock.logout().catch(() => {});
  } catch (e) {
    logError("Erreur logout() pendant la regeneration QR", e);
  }
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.rmSync(AUTH_BACKUP_DIR, { recursive: true, force: true });
  } catch (e) {
    logError("Erreur suppression session pendant la regeneration QR", e);
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWaSocket().catch((e) => {
      logError("Erreur reinitialisation WA (/qr)", e);
      waRestartInProgress = false;
    });
  }, 1000);
}

process.on("unhandledRejection", (reason) => {
  const msg = (reason && reason.message) || String(reason);
  logError("Rejet de promesse non gere", reason);
  if (isFatalWaError(msg) && sock) requestWaSocketEnd(`unhandledRejection: ${msg}`);
});

process.on("uncaughtException", (err) => {
  logError("Exception non interceptee", err);
  if (isFatalWaError(err.message) && sock) requestWaSocketEnd(`uncaughtException: ${err.message}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM recu, fermeture propre du socket WhatsApp...");
  clearPendingReconnect();
  if (authBackupInterval) clearInterval(authBackupInterval);
  try { if (sock) sock.end(undefined); } catch (_) {}
  releaseSingleInstanceLock();
  setTimeout(() => process.exit(0), 500);
});

process.on("exit", releaseSingleInstanceLock);

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
      console.log(`Groupe restaure : ${selectedGroupId}`);
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
    console.log("Liens charges :", Object.keys(accountLinks).length);
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

function isTransientSessionError(e) {
  const msg = (e && e.message) || String(e);
  return (
    msg.includes("No sessions") ||
    msg.includes("SessionError") ||
    (e && e.name === "SessionError")
  );
}

async function sendWaMessage(jid, content, options = {}) {
  const payload = typeof content === "string" ? { text: content } : { ...content };
  if (options.mentions && options.mentions.length) payload.mentions = options.mentions;

  const sendOptions = {};
  if (options.quotedMessageId) {
    const quotedMsg = waMessageStore.get(options.quotedMessageId);
    if (quotedMsg) sendOptions.quoted = quotedMsg;
  }

  try {
    const sent = await sock.sendMessage(jid, payload, sendOptions);
    if (sent) rememberWaMessage(sent);
    return sent;
  } catch (e) {
    if (!isTransientSessionError(e)) throw e;
    for (const delayMs of [15000, 20000]) {
      console.warn(`Session pas encore prete pour ${jid}, nouvelle tentative dans ${delayMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        const sent = await sock.sendMessage(jid, payload, sendOptions);
        if (sent) rememberWaMessage(sent);
        return sent;
      } catch (e2) {
        if (!isTransientSessionError(e2)) throw e2;
      }
    }
    throw e;
  }
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
    logError("getSelectedGroup a echoue", e);
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
    console.log("Mutes charges :", Object.keys(mutedUsers).length, "actifs");
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
const DISCORD_POLL_MAX_ANSWERS = 10;

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

function extractWaPollData(msg) {
  const type = getMessageContentType(msg);
  if (!POLL_CREATION_TYPES.includes(type)) return null;
  const poll = msg.message[type];
  if (!poll) return null;

  const question = poll.name || "Sondage";
  const options  = (poll.options || []).map((o) => o.optionName).filter(Boolean);
  const multi    = !poll.selectableOptionsCount || poll.selectableOptionsCount > 1;

  if (!options.length) return null;
  return { question, options, multi };
}

function formatWaPoll(msg) {
  const data = extractWaPollData(msg);
  if (!data) return null;
  const options = data.options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  return `*Sondage${data.multi ? " (choix multiples)" : ""} :* ${data.question}\n${options}`;
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

const linkedMemberCache = new Map();
const LINKED_MEMBER_CACHE_TTL = 5 * 60 * 1000;

async function getLinkedDiscordDisplayName(number) {
  if (!number) return null;
  const link = findLinkByWaNumber(number);
  if (!link) return null;

  const cached = linkedMemberCache.get(link.discordId);
  if (cached && Date.now() - cached.at < LINKED_MEMBER_CACHE_TTL) {
    return cached.name;
  }

  try {
    const guild = discordClient.guilds.cache.first();
    if (guild) {


      let member = guild.members.cache.get(link.discordId);
      if (!member) {
        member = await guild.members.fetch(link.discordId).catch(() => null);
      }
      if (member) {
        const name = member.nickname || member.user.username;
        linkedMemberCache.set(link.discordId, { name, at: Date.now() });
        return name;
      }
    }
  } catch (e) {
    logError("Erreur resolution nom Discord lie", e);
  }

  return link.discordUsername || null;
}

async function getContactDisplayName(jid) {
  if (!jid) return "Inconnu";
  const number = jid.split("@")[0];

  const linkedName = await getLinkedDiscordDisplayName(number);
  if (linkedName) return linkedName;

  return (
    contactSavedNameCache.get(jid) ||
    contactNotifyNameCache.get(jid) ||
    number
  );
}

async function getSenderName(msg) {
  const jid = getSenderJid(msg);
  const number = jid ? jid.split("@")[0] : "Inconnu";





  const linkedName = await getLinkedDiscordDisplayName(number);
  if (linkedName) return linkedName;




  return (
    contactSavedNameCache.get(jid) ||
    msg.pushName ||
    contactNotifyNameCache.get(jid) ||
    number
  );
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
    requestWaSocketEnd(`commande utilisateur: ${e.message}`);
    return "WhatsApp semble deconnecte. Reconnexion automatique en cours, reessaie dans 10-15 secondes.";
  }
  return `Erreur : ${e.message}`;
}

async function buildReplyPrefix(quotedDiscordId) {
  if (!quotedDiscordId) return "";
  try {
    const channel  = await getDiscordChannel();
    const original = await channel.messages.fetch(quotedDiscordId);
    const author   = original.member ? original.member.displayName : original.author.username;
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

    const name  = await getContactDisplayName(jid);
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
      await sendWaReply(msg, "Reponds a un message vocal avec !txt.");
      return;
    }

    const quotedType = getContentType(ctx.quotedMessage);
    if (quotedType !== "audioMessage") {
      await sendWaReply(msg, "Le message cite n'est pas un message vocal.");
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
      await sendWaReply(msg, "Impossible de recuperer le message vocal cite (lien expire). Reessaie avec un vocal plus recent.");
      return;
    }

    if (!buffer) {
      await sendWaReply(msg, "Impossible de telecharger l'audio (media expire ou indisponible).");
      return;
    }

    const { filepath } = saveMediaBuffer(buffer, "ogg");
    await sendWaReply(msg, "Transcription en cours...");
    const transcript = await transcribeVoiceNote(filepath);

    await sendWaReply(
      msg,
      transcript
        ? `*Transcription :*\n${transcript}`
        : "Impossible de transcrire ce message vocal (voir logs serveur pour le detail Groq)."
    );
  } catch (e) {
    logError("Erreur !txt WA", e);
    await sendWaReply(msg, `Erreur : ${e.message}`);
  }
}

async function handleTxtCommandDiscord(msg) {
  if (!msg.reference || !msg.reference.messageId) {
    await msg.reply("Reponds a un message vocal (fichier audio) avec `!txt`.");
    return;
  }

  try {
    const channel  = await getDiscordChannel();
    const original = await channel.messages.fetch(msg.reference.messageId);
    const audioAtt = original.attachments.find((a) =>
      a.name && [".ogg", ".mp3", ".m4a", ".wav", ".webm"].some((ext) => a.name.endsWith(ext))
    );

    if (!audioAtt) {
      await msg.reply("Aucun fichier audio trouve dans ce message.");
      return;
    }

    await msg.reply("Transcription en cours...");
    const res      = await fetch(audioAtt.url);
    const buffer   = await res.buffer();
    const filepath = `${MEDIA_DIR}/${Date.now()}_${audioAtt.name}`;
    fs.writeFileSync(filepath, buffer);

    const transcript = await transcribeVoiceNote(filepath);
    await msg.reply(
      transcript
        ? `**Transcription :**\n> ${transcript}`
        : "Impossible de transcrire ce message vocal."
    );
  } catch (e) {
    logError("Erreur !txt Discord", e);
    await msg.reply(`Erreur : ${e.message}`);
  }
}

async function handleTxtCommand(msg, source) {
  if (source === "wa") return handleTxtCommandWa(msg);
  if (source === "dc") return handleTxtCommandDiscord(msg);
}

// ==========================================================================
// SLASH COMMANDS : DEFINITION ET ENREGISTREMENT
// ==========================================================================

// ==========================================================================
// MISE A JOUR GITHUB AUTOMATIQUE (verif au demarrage + bouton Oui/Non)
// ==========================================================================

function isGitRepo() {
  return fs.existsSync(`${__dirname}/.git`);
}

function getCurrentBranch() {
  return execSync("git rev-parse --abbrev-ref HEAD", { cwd: __dirname }).toString().trim();
}

function getLocalCommitHash() {
  return execSync("git rev-parse HEAD", { cwd: __dirname }).toString().trim();
}

function getRemoteCommitHash(branch) {
  execSync("git fetch origin --quiet", { cwd: __dirname, timeout: 20000 });
  return execSync(`git rev-parse origin/${branch}`, { cwd: __dirname }).toString().trim();
}

function getUpdateCommitLog(branch) {
  try {
    return execSync(`git log HEAD..origin/${branch} --oneline --max-count=10`, { cwd: __dirname })
      .toString()
      .trim();
  } catch (_) {
    return "";
  }
}

function loadUpdateState() {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_STATE_FILE, "utf8"));
  } catch (_) {
    return { lastPromptedCommit: null };
  }
}

function saveUpdateState(state) {
  try {
    fs.writeFileSync(UPDATE_STATE_FILE, JSON.stringify(state));
  } catch (e) {
    logError("Erreur sauvegarde etat mise a jour", e);
  }
}

async function checkForGitHubUpdate({ force = false } = {}) {
  if (!isGitRepo()) return { available: false, reason: "pas un depot git" };

  try {
    const branch = getCurrentBranch();
    const local  = getLocalCommitHash();
    const remote = getRemoteCommitHash(branch);

    if (local === remote) return { available: false };

    const state = loadUpdateState();
    if (!force && state.lastPromptedCommit === remote) {
      return { available: true, alreadyPrompted: true, remote, branch };
    }

    const log = getUpdateCommitLog(branch);
    return { available: true, alreadyPrompted: false, remote, local, branch, log };
  } catch (e) {
    logError("Erreur verification mise a jour GitHub", e);
    return { available: false, error: e.message };
  }
}

async function promptGitHubUpdate(update) {
  try {
    const channel = await getDiscordChannel();
    const commitList = update.log ? `\n\`\`\`\n${update.log}\n\`\`\`` : "";
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("update_yes").setLabel("Oui, installer").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("update_no").setLabel("Non, plus tard").setStyle(ButtonStyle.Secondary)
    );
    await channel.send({
      content: `Nouvelle mise a jour disponible sur GitHub (branche \`${update.branch}\`) :${commitList}\nVoulez-vous l'installer maintenant ? Le bot redemarrera automatiquement apres.`,
      components: [row],
    });
    saveUpdateState({ lastPromptedCommit: update.remote });
  } catch (e) {
    logError("Erreur envoi proposition de mise a jour", e);
  }
}

function performGitUpdate(branch) {
  const cwd = __dirname;
  execSync(`git pull --ff-only origin ${branch}`, { cwd, timeout: 30000 });

  let changedFiles = "";
  try {
    changedFiles = execSync("git diff --name-only ORIG_HEAD HEAD", { cwd }).toString();
  } catch (_) {}

  if (/package(-lock)?\.json/.test(changedFiles)) {
    execSync("npm install --production", { cwd, timeout: 120000 });
  }
}

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Verifie la latence du bot"),
  new SlashCommandBuilder().setName("status").setDescription("Etat de la connexion WhatsApp et du groupe selectionne"),
  new SlashCommandBuilder().setName("groupes").setDescription("Liste les groupes WhatsApp disponibles"),
  new SlashCommandBuilder()
    .setName("select")
    .setDescription("Selectionne un groupe WhatsApp")
    .addIntegerOption((opt) => opt.setName("numero").setDescription("Numero du groupe (voir /groupes)").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("Affiche la liste des commandes disponibles"),
  new SlashCommandBuilder().setName("qr").setDescription("Force l'envoi (ou la regeneration) du QR code de connexion WhatsApp"),
  new SlashCommandBuilder()
    .setName("connexion")
    .setDescription("Connecte WhatsApp sans QR code : recois un code de couplage a entrer sur ton telephone")
    .addStringOption((opt) => opt.setName("numero").setDescription("Numero WhatsApp avec indicatif pays, ex: 33612345678").setRequired(true)),
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Lie ton pseudo Discord et ton numero WhatsApp (sert a la sync des mentions @)")
    .addStringOption((opt) => opt.setName("pseudo").setDescription("Ton nom d'utilisateur Discord").setRequired(true))
    .addStringOption((opt) => opt.setName("numero").setDescription("Ton numero WhatsApp (ex: 33612345678)").setRequired(true)),
  new SlashCommandBuilder().setName("update").setDescription("Verifie s'il y a une mise a jour disponible sur GitHub"),
].map((cmd) => cmd.toJSON());

async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    console.log("Enregistrement des slash commands...");
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), { body: commands });
    console.log("Slash commands enregistrees.");
  } catch (e) {
    logError("Erreur enregistrement slash commands", e);
  }
}

// ==========================================================================
// DISCORD : READY
// ==========================================================================

discordClient.once("clientReady", async () => {
  console.log(`Discord connecte : ${discordClient.user.tag}`);
  await registerSlashCommands();

  const update = await checkForGitHubUpdate();
  if (update.available && !update.alreadyPrompted) {
    await promptGitHubUpdate(update);
  } else if (update.available && update.alreadyPrompted) {
    console.log("Mise a jour GitHub deja proposee pour ce commit, pas de re-notification.");
  }
});

// ==========================================================================
// DISCORD : INTERACTIONS (SLASH COMMANDS)
// ==========================================================================

const HELP_TEXT_SLASH =
  "**Commandes slash :**\n" +
  "`/ping` - Latence du bot\n" +
  "`/groupes` - Liste les groupes WA\n" +
  "`/select <n>` - Selectionne un groupe WA\n" +
  "`/status` - Etat de la connexion\n" +
  "`/qr` - Force la regeneration et l'envoi du QR code de connexion WhatsApp\n" +
  "`/connexion <numero>` - Connecte WhatsApp sans QR : recois un code de couplage en MP\n" +
  "`/link <pseudo> <numero>` - Lie ton pseudo Discord et ton numero WhatsApp (sync des @)\n" +
  "`/update` - Verifie s'il y a une mise a jour GitHub disponible\n" +
  "`/help` - Cette aide\n\n" +
  "**Commandes `!` (Discord & WA) :**\n" +
  "`!txt` - Transcrit un message vocal (reply sur le vocal)\n" +
  "`!mute @Membre 2h` - Mute un membre (admins WA)\n" +
  "`!unmute @Membre` - Unmute un membre (admins WA)\n" +
  "`!groupes` / `!select <n>` / `!status` / `!help` - Commandes bridge\n\n" +
  "**Sondages :** un sondage cree sur Discord est recree automatiquement comme vrai sondage WhatsApp, " +
  "et un sondage WhatsApp est relaye sur Discord sous forme de message (question + options).";

discordClient.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId === "update_yes") {
      try {
        await interaction.update({ content: "Installation de la mise a jour en cours...", components: [] });
        const branch = getCurrentBranch();
        performGitUpdate(branch);
        await interaction.channel.send(
          "Mise a jour installee avec succes. Redemarrage du bot dans quelques secondes..."
        );
        console.log("Mise a jour GitHub installee, redemarrage du process...");
        clearPendingReconnect();
        if (authBackupInterval) clearInterval(authBackupInterval);
        try { if (sock) sock.end(undefined); } catch (_) {}
        releaseSingleInstanceLock();

        setTimeout(() => process.exit(0), 1500);
      } catch (e) {
        logError("Erreur installation mise a jour GitHub", e);
        try {
          await interaction.channel.send(
            `Echec de la mise a jour : ${e.message}\nLe bot continue de tourner avec la version actuelle, rien n'a ete casse.`
          );
        } catch (_) {}
      }
      return;
    }

    if (interaction.customId === "update_no") {
      try {
        await interaction.update({ content: "Mise a jour ignoree pour le moment (tu peux relancer `/update` plus tard).", components: [] });
      } catch (_) {}
      return;
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.channelId !== DISCORD_CHANNEL_ID) {
    try {
      await interaction.reply({ content: "Utilise cette commande dans le bon salon.", ephemeral: true });
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
    await safeReply(`Pong ! Latence : **${latency}ms** | WebSocket : **${discordClient.ws.ping}ms**`);
    return;
  }

  if (commandName === "help") {
    await safeReply(HELP_TEXT_SLASH);
    return;
  }

  if (commandName === "update") {
    await safeReply("Verification des mises a jour GitHub...");
    const update = await checkForGitHubUpdate({ force: true });
    if (update.error) {
      await interaction.channel.send(`Impossible de verifier les mises a jour : ${update.error}`);
    } else if (!update.available) {
      await interaction.channel.send("Le bot est deja a jour, rien a installer.");
    } else {
      await promptGitHubUpdate(update);
    }
    return;
  }

  if (commandName === "link") {
    try {
      const pseudo = interaction.options.getString("pseudo").trim();
      const numero = normalizeWaNumber(interaction.options.getString("numero"));

      if (!numero || numero.length < 8) {
        await safeReply({ content: "Numero WhatsApp invalide. Exemple : `33612345678`", ephemeral: true });
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
        content: `Lien cree : **${resolvedName}** **+${numero}**\nLes mentions \`@\` seront desormais correctement synchronisees entre Discord et WhatsApp.`,
        ephemeral: true,
      });
    } catch (e) {
      logError("Erreur /link", e);
      await safeReply({ content: `Erreur : ${e.message}`, ephemeral: true });
    }
    return;
  }

  if (commandName === "qr") {
    if (waReady) {
      await safeReply("WhatsApp est deja connecte, pas besoin de QR code.\nSi tu veux quand meme reconnecter avec un nouveau numero, utilise `/qr` apres avoir deconnecte l'appareil lie depuis WhatsApp > Appareils connectes.");
      return;
    }
    if (waRestartInProgress) {
      await safeReply("Le client WhatsApp est en cours de (re)demarrage, patiente quelques secondes et reessaie - le QR arrivera automatiquement s'il en faut un.");
      return;
    }
    await safeReply("Regeneration du QR code en cours... il sera envoye sur ce salon dans quelques secondes.");
    forceQrResend();
    return;
  }

  if (commandName === "connexion") {
    const numero = normalizeWaNumber(interaction.options.getString("numero"));
    if (!numero || numero.length < 8) {
      await safeReply({ content: "Numero invalide. Exemple : `33612345678` (indicatif pays + numero, sans le `+` ni espaces).", ephemeral: true });
      return;
    }
    if (waReady) {
      await safeReply({ content: "WhatsApp est deja connecte, pas besoin de code de couplage.", ephemeral: true });
      return;
    }
    if (waRestartInProgress) {
      await safeReply({ content: "Le client WhatsApp est en cours de (re)demarrage, patiente quelques secondes et reessaie.", ephemeral: true });
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
          `Ton code de couplage WhatsApp : **${code}**\n\n` +
          "Sur ton telephone : ouvre **WhatsApp** > *Reglages* > *Appareils connectes* > *Lier un appareil* > " +
          "**Lier avec le numero de telephone a la place** > entre ce code.\n" +
          "Il expire au bout de quelques minutes, fais vite."
        );
        await safeReply({ content: "Le code de couplage t'a ete envoye en message prive." });
      } catch (dmError) {
        await safeReply({ content: `Impossible de t'envoyer un MP (verifie que tes messages prives sont ouverts pour ce serveur). Ton code : **${code}**` });
      }
    } catch (e) {
      logError("Erreur /connexion (requestPairingCode)", e);
      await safeReply({ content: `Erreur lors de la generation du code : ${e.message}` });
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
          ? `WhatsApp connecte\nGroupe : **${group ? group.name : "aucun selectionne"}**`
          : "WhatsApp non connecte"
      );
    } catch (e) {
      logError("Erreur /status", e);
      await safeReply(`Erreur : ${e.message}`);
    }
    return;
  }

  if (commandName === "groupes") {
    if (!waReady) {
      await safeReply("WhatsApp n'est pas encore pret (session en cours d'initialisation). Reessaie dans quelques secondes, ou utilise `/status` pour verifier.");
      return;
    }
    try {
      const groups = await getWaGroups();
      if (!groups.length) {
        await safeReply("Aucun groupe trouve.");
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
      await safeReply("WhatsApp n'est pas encore pret (session en cours d'initialisation). Reessaie dans quelques secondes, ou utilise `/status` pour verifier.");
      return;
    }
    try {
      const index  = interaction.options.getInteger("numero") - 1;
      const groups = await getWaGroups();
      if (Number.isNaN(index) || !groups[index]) {
        await safeReply("Numero invalide. Utilise `/groupes`.");
        return;
      }
      selectedGroupId = groups[index].id._serialized;
      saveSelectedGroup();
      invalidateGroupCache();
      await safeReply(`Groupe selectionne : **${groups[index].name}**`);
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
  clearPendingReconnect();
  waRestartInProgress = true;

  const { state, saveCreds } = await useHardenedMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const newSock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, waLogger),
    },
    logger: waLogger,
    browser: Browsers.ubuntu("Chrome"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    msgRetryCounterCache: new NodeCache(),



  });




  sock = newSock;

  newSock.ev.on("creds.update", saveCreds);

  newSock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      if (!c.id) continue;
      if (c.name) contactSavedNameCache.set(c.id, c.name);
      if (c.notify) contactNotifyNameCache.set(c.id, c.notify);
    }
  });
  newSock.ev.on("contacts.update", (contacts) => {
    for (const c of contacts) {
      if (!c.id) continue;


      if (c.name) contactSavedNameCache.set(c.id, c.name);
      if (c.notify) contactNotifyNameCache.set(c.id, c.notify);
    }
  });

  newSock.ev.on("connection.update", async (update) => {
    if (sock !== newSock) return;
    try {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        clearPendingReconnect();
        waRestartInProgress = false;
        try {
          console.log("QR code recu, generation en cours...");
          const dataUrl = await qrcode.toDataURL(qr);
          const base64  = dataUrl.replace(/^data:image\/png;base64,/, "");
          fs.writeFileSync("qr.png", base64, "base64");
          await withRetry(async () => {
            const channel = await getDiscordChannel();
            await channel.send({ content: "Scanne ce QR code pour connecter WhatsApp", files: ["qr.png"] });
          }, { attempts: 3, delayMs: 3000 });
          console.log("QR code envoye sur Discord.");
        } catch (e) {
          logError("Erreur QR (echec apres plusieurs tentatives)", e);



        }
      }

      if (connection === "open") {
        console.log("WhatsApp connecte");
        clearPendingReconnect();
        waRestartInProgress = false;
        reconnectAttempts = 0;
        discordNotifiedThisCycle = false;
        badSessionRestoreAttempted = false;
        startAuthBackupSchedule();
        await new Promise((r) => setTimeout(r, 5000));
        if (sock !== newSock) return;
        startTimestamp = Math.floor(Date.now() / 1000);
        waReady = true;
        console.log("WhatsApp pret");
      }

      if (connection === "close") {
        waReady = false;
        invalidateGroupCache();

        const statusCode = lastDisconnect && lastDisconnect.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : null;
        const errMsg = lastDisconnect && lastDisconnect.error ? lastDisconnect.error.message : "raison inconnue";
        console.warn(`WhatsApp deconnecte, code : ${statusCode} - ${errMsg}`);

        const needsFreshSession =
          statusCode === DisconnectReason.loggedOut ||
          statusCode === DisconnectReason.badSession ||
          statusCode === DisconnectReason.multideviceMismatch;




        const isBenignRestart = statusCode === DisconnectReason.restartRequired;





        const isConflict = statusCode === DisconnectReason.connectionReplaced;

        if (needsFreshSession) {





          if (
            statusCode === DisconnectReason.badSession &&
            !badSessionRestoreAttempted &&
            restoreAuthBackup()
          ) {
            badSessionRestoreAttempted = true;
            notifyDiscordOnce(
              "Session WhatsApp corrompue localement, tentative de restauration depuis une sauvegarde recente..."
            ).catch(() => {});
            scheduleReconnect(`badSession, restauration backup tentee`, { immediate: true });
            return;
          }

          badSessionRestoreAttempted = false;
          notifyDiscordOnce(
            `Session WhatsApp invalidee (code ${statusCode}). Nettoyage de la session et reconnexion... ` +
            "Utilise /qr ou /connexion pour rescanner/relier l'appareil."
          ).catch(() => {});
          scheduleReconnect(`session invalide (${statusCode}): ${errMsg}`, { clearSession: true, immediate: true });
          return;
        }

        if (isBenignRestart) {
          scheduleReconnect(`restartRequired: ${errMsg}`, { immediate: true });
          return;
        }

        if (isConflict) {
          notifyDiscordOnce(
            `WhatsApp signale qu'une autre connexion a pris le relais (code ${statusCode}). ` +
            "Verifie qu'il n'y a pas deux instances du bot qui tournent (ex: doublon PM2). Nouvelle tentative dans quelques instants..."
          ).catch(() => {});


          reconnectAttempts = Math.max(reconnectAttempts, 2);
          scheduleReconnect(`connectionReplaced: ${errMsg}`);
          return;
        }





        if (reconnectAttempts > 0) {
          notifyDiscordOnce("Le pont WhatsApp a rencontre un probleme et se reconnecte automatiquement...").catch(() => {});
        } else {
          console.log(`Micro-accroc reseau (${statusCode}: ${errMsg}), reconnexion silencieuse en cours...`);
        }
        scheduleReconnect(`${statusCode || "close"}: ${errMsg}`);
      }
    } catch (e) {




      logError("Erreur interne dans connection.update", e);
      if (!reconnectTimer) {
        scheduleReconnect(`erreur interne connection.update: ${e.message}`);
      }
    }
  });

  newSock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (sock !== newSock) return;
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        await handleIncomingWaMessage(m);
      } catch (e) {
        logError("Erreur traitement message WA", e);
      }
    }
  });

  return newSock;
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

  if (msg.key.fromMe) {
    const rawText = extractText(msg).trim();
    if (rawText === "!txt") {
      sentByBridge.add(waId);
      await handleTxtCommand(msg, "wa");
    }
    return;
  }

  const senderJid = getSenderJid(msg);
  const name      = await getSenderName(msg);
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
    log("MUTE_BLOCK", name, "Message supprime (mute actif)");
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
      const name = await getContactDisplayName(senderJid);
      await webhook.editMessage(discordId, { content: `${name} : ${newText || "[MEDIA]"} *(edite)*` });
    } catch (e) {
      if (!e.message.includes("Unknown Message")) logError("Erreur edition WA->DC", e);
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
    await group.sendMessage("Seuls les admins peuvent utiliser !mute.", { quotedMessageId: waId });
    return;
  }

  const parts       = rawText.trim().split(/\s+/);
  const durationStr = parts[parts.length - 1];
  const durationMs  = parseDuration(durationStr);
  if (!durationMs) {
    await group.sendMessage(
      "Format invalide. Exemple : `!mute @Personne 2d`\nUnites : m (minutes), h (heures), d (jours)",
      { quotedMessageId: waId }
    );
    return;
  }

  const targetJid = resolveMentionedJid(msg);
  if (!targetJid) {
    await group.sendMessage("Mentionne un membre avec @.", { quotedMessageId: waId });
    return;
  }

  const targetName    = await getContactDisplayName(targetJid);
  const targetIsAdmin = isGroupAdmin(targetJid, group);
  if (targetIsAdmin) {
    await group.sendMessage("Impossible de muter un admin du groupe.", { quotedMessageId: waId });
    return;
  }

  const expireAt = Date.now() + durationMs;
  mutedUsers[targetJid] = expireAt;
  saveMutes();
  log("MUTE", name, `${targetName} mute jusqu'au ${formatExpire(expireAt)}`);

  await group.sendMessage(
    `*${targetName}* est mute jusqu'au *${formatExpire(expireAt)}*.\n` +
    "Ses messages seront automatiquement supprimes.\n" +
    `Un admin peut le demuter avec \`!unmute @${targetName}\`.`,
    { quotedMessageId: waId }
  );
}

async function handleUnmuteCommand(msg, group, senderJid, name, waId) {
  const adminCheck = isGroupAdmin(senderJid, group);
  if (!adminCheck) {
    await group.sendMessage("Seuls les admins peuvent utiliser !unmute.", { quotedMessageId: waId });
    return;
  }

  const targetJid = resolveMentionedJid(msg);
  if (!targetJid) {
    await group.sendMessage("Mentionne un membre avec @.", { quotedMessageId: waId });
    return;
  }

  const targetName = await getContactDisplayName(targetJid);

  if (mutedUsers[targetJid]) {
    delete mutedUsers[targetJid];
    saveMutes();
    log("UNMUTE", name, `${targetName} demute par ${name}`);
    await group.sendMessage(
      `*${targetName}* a ete demute par *${name}*.\nIl peut de nouveau envoyer des messages.`,
      { quotedMessageId: waId }
    );
  } else {
    await group.sendMessage(`*${targetName}* n'est pas mute.`, { quotedMessageId: waId });
  }
}

async function relayWaPollToDiscord(msg, name, waId) {
  const data = extractWaPollData(msg);
  if (!data) {
    log("WA->DC", name, "[SONDAGE] Format de sondage non reconnu, ignore.");
    return;
  }

  let answers = data.options;
  if (answers.length > DISCORD_POLL_MAX_ANSWERS) {
    log("WA->DC", name, `[SONDAGE] ${answers.length} options tronquees a ${DISCORD_POLL_MAX_ANSWERS} (limite Discord)`);
    answers = answers.slice(0, DISCORD_POLL_MAX_ANSWERS);
  }

  log("WA->DC", name, `[SONDAGE] ${data.question}`);

  try {



    const channel = await getDiscordChannel();
    const sent = await channel.send({
      content: `**${name}** a cree un sondage WhatsApp :`,
      poll: {
        question: { text: data.question },
        answers: answers.map((text) => ({ text })),
        duration: 168,
        allowMultiselect: data.multi,
      },
    });
    waToDiscord.set(waId, sent.id);
    discordToWa.set(sent.id, waId);
  } catch (e) {
    logError("Erreur creation sondage Discord depuis WA", e);



    try {
      const fallbackText = formatWaPoll(msg) || "Sondage WhatsApp";
      const webhookOptions = { username: name, content: fallbackText };
      const avatarUrl = await getContactAvatarUrl(getSenderJid(msg));
      if (avatarUrl) webhookOptions.avatarURL = avatarUrl;
      const sent = await webhook.send(webhookOptions);
      waToDiscord.set(waId, sent.id);
      discordToWa.set(sent.id, waId);
    } catch (e2) {
      logError("Erreur fallback texte sondage WA->DC", e2);
    }
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
    await relayWaPollToDiscord(msg, name, waId);
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
            ? `*Message vocal :*\n> ${transcript}`
            : "*Message vocal* - reponds avec `!txt` pour transcrire",
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
      await message.reply("WhatsApp n'est pas encore pret (session en cours d'initialisation). Reessaie dans quelques secondes.");
      return true;
    }
    try {
      const groups = await getWaGroups();
      if (!groups.length) {
        await message.reply("Aucun groupe trouve.");
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
      await message.reply("WhatsApp n'est pas encore pret (session en cours d'initialisation). Reessaie dans quelques secondes.");
      return true;
    }
    try {
      const index  = parseInt(content.split(" ")[1], 10) - 1;
      const groups = await getWaGroups();
      if (Number.isNaN(index) || !groups[index]) {
        await message.reply("Numero invalide. Utilise /groupes.");
      } else {
        selectedGroupId = groups[index].id._serialized;
        saveSelectedGroup();
        invalidateGroupCache();
        await message.reply(`Groupe selectionne : ${groups[index].name}`);
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
        waReady ? `WhatsApp connecte\nGroupe : ${group ? group.name : "aucun selectionne"}` : "WhatsApp non connecte"
      );
    } catch (e) {
      logError("Erreur !status", e);
    }
    return true;
  }

  if (content === "!qr") {
    if (waReady) {
      await message.reply("WhatsApp est deja connecte, pas besoin de QR code.");
    } else if (waRestartInProgress) {
      await message.reply("Le client WhatsApp est en cours de (re)demarrage, patiente quelques secondes et reessaie.");
    } else {
      await message.reply("Regeneration du QR code en cours... il sera envoye sur ce salon dans quelques secondes.");
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
      "`!txt` - Transcrit un message vocal (reply sur le message audio)\n" +
      "`!groupes` - Liste les groupes WA\n" +
      "`!select <n>` - Selectionne un groupe WA\n" +
      "`!status` - Etat connexion\n" +
      "`!qr` - Force l'envoi du QR code de connexion WhatsApp\n" +
      "`!connexion <numero>` - Connecte WhatsApp sans QR : recois un code de couplage en MP\n" +
      "`!help` - Cette aide\n" +
      "Slash : `/ping` `/groupes` `/select` `/status` `/link` `/qr` `/connexion` `/help`"
    );
    return true;
  }

  return false;
}

async function handleBangConnexion(message, content) {
  const numero = normalizeWaNumber(content.split(" ")[1] || "");
  if (!numero || numero.length < 8) {
    await message.reply("Numero invalide. Exemple : `!connexion 33612345678` (indicatif pays + numero, sans le `+` ni espaces).");
    return;
  }
  if (waReady) {
    await message.reply("WhatsApp est deja connecte, pas besoin de code de couplage.");
    return;
  }
  if (waRestartInProgress) {
    await message.reply("Le client WhatsApp est en cours de (re)demarrage, patiente quelques secondes et reessaie.");
    return;
  }

  try {
    const code = await sock.requestPairingCode(numero);
    try {
      await message.author.send(
        `Ton code de couplage WhatsApp : **${code}**\n\n` +
        "Sur ton telephone : ouvre **WhatsApp** > *Reglages* > *Appareils connectes* > *Lier un appareil* > " +
        "**Lier avec le numero de telephone a la place** > entre ce code.\n" +
        "Il expire au bout de quelques minutes, fais vite."
      );
      await message.reply("Le code de couplage t'a ete envoye en message prive.");
    } catch (dmError) {
      await message.reply(`Impossible de t'envoyer un MP (verifie que tes messages prives sont ouverts). Ton code : **${code}**`);
    }
  } catch (e) {
    logError("Erreur !connexion (requestPairingCode)", e);
    await message.reply(`Erreur lors de la generation du code : ${e.message}`);
  }
}

async function relayDiscordPollToWa(message, group, name) {
  try {
    const poll = message.poll;
    const question = poll.question && poll.question.text ? poll.question.text : "Sondage";
    const answers = Array.from(poll.answers.values())
      .map((a) => (a.text || "Option").trim())
      .filter(Boolean)
      .slice(0, 12);

    if (answers.length < 2) {
      log("DC->WA_ERROR", name, "Sondage ignore (moins de 2 options valides)");
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
      log("DC->WA_FAIL", name, `Sondage non envoye : ${question}`);
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
    log("DC->WA_BLOCKED", name, `Message ignore (contient @here) : ${content}`);
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
    logError("Erreur edition DC->WA", e);
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
      await message.reply("Aucun groupe selectionne. Utilise `/select <n>`.");
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
    await message.reply("Aucun groupe selectionne. Utilise `/select <n>`.");
    return;
  }

  await relayDiscordMessageToWa(message, group, name, content);
});

// ==========================================================================
// DEMARRAGE
// ==========================================================================

acquireSingleInstanceLock();

loadSelectedGroup();
loadLinks();
loadMutes();

discordClient.login(DISCORD_TOKEN)
  .then(() => console.log("Connexion Discord lancee"))
  .catch((e) => logError("Erreur connexion Discord", e));

startWaSocket().catch((e) => {
  logError("Erreur initialisation WA", e);
  waRestartInProgress = false;
  scheduleReconnect(`echec demarrage initial: ${e.message}`);
});