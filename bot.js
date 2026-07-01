const fs      = require("fs");
const qrcode  = require("qrcode");
const fetch   = require("node-fetch");
const FormData = require("form-data");

const {
  Client,
  GatewayIntentBits,
  WebhookClient,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const { Client: WAClient, LocalAuth, MessageMedia } = require("whatsapp-web.js");

// ================= CONFIG =================

const DISCORD_TOKEN      = "tok token";
const DISCORD_CHANNEL_ID = "ton chanelle id";
const WEBHOOK_URL        = "ton webhook URL";
const DISCORD_CLIENT_ID  = "ton id d'aplication";
const DISCORD_GUILD_ID   = "ton id de serveur";
const GROQ_API_KEY       = "Ton API key";

const MEDIA_DIR   = "./media";                    //posibilité de chager la localisation
const LOG_FILE    = "./bridge.log";               //posibilité de chager la localisation
const MUTES_FILE  = "./mutes.json";               //posibilité de chager la localisation
const GROUP_FILE  = "./selected_group.json";      //posibilité de chager la localisation
const LINKS_FILE  = "./links.json";               //posibilité de chager la localisation

const GUILD_MEMBERS_CACHE_TTL = 5 * 60 * 1000;

// ================= CHROMIUM =================

const CHROMIUM_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe" : null,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findChromium() {
  for (const p of CHROMIUM_PATHS) {
    if (fs.existsSync(p)) {
      console.log("Chromium: " + p);
      return p;
    }
  }
  return undefined;
}

// ================= INIT =================

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

const waClient = new WAClient({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: findChromium(),
    protocolTimeout: 120000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
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

// ================= RESILIENCE : REDEMARRAGE AUTO DU CLIENT WA =================

function isFatalWaError(message) {
  if (!message) return false;
  const m = String(message);
  return (
    m.includes("Protocol error") ||
    m.includes("Target closed") ||
    m.includes("Session closed") ||
    m.includes("Execution context was destroyed") ||
    m.includes("Cannot read properties of undefined") ||
    m.includes("Most likely the page has been closed")
  );
}

let waRestartInProgress = false;

async function restartWaClient(reason) {
  if (waRestartInProgress) return;
  waRestartInProgress = true;
  waReady = false;
  invalidateGroupCache();
  console.error("Redemarrage du client WhatsApp suite a : " + reason);

  try {
    const channel = await getDiscordChannel();
    await channel.send("⚠️ Le pont WhatsApp a rencontré un problème (crash Chrome/Puppeteer) et se reconnecte automatiquement...");
  } catch (_) {}

  try {
    await waClient.destroy();
  } catch (e) {
    console.error("Erreur destroy() pendant le redemarrage :", e.message);
  }

  setTimeout(() => {
    waRestartInProgress = false;
    waClient.initialize().catch((e) => {
      console.error("Erreur reinitialisation du client WA :", e.message);
    });
  }, 5000);
}

process.on("unhandledRejection", (reason) => {
  const msg = (reason && reason.message) || String(reason);
  console.error("Rejet de promesse non gere :", msg);
  if (isFatalWaError(msg)) restartWaClient("unhandledRejection: " + msg);
});
process.on("uncaughtException", (err) => {
  console.error("Exception non interceptee :", err.message);
  if (isFatalWaError(err.message)) restartWaClient("uncaughtException: " + err.message);
});

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

// ================= LIENS DISCORD <-> WHATSAPP =================
let accountLinks = {};

function loadLinks() {
  try {
    if (fs.existsSync(LINKS_FILE)) {
      accountLinks = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
      console.log("Liens charges :", Object.keys(accountLinks).length);
    }
  } catch (e) {
    console.error("Erreur chargement liens :", e.message);
    accountLinks = {};
  }
}

function saveLinks() {
  try {
    fs.writeFileSync(LINKS_FILE, JSON.stringify(accountLinks, null, 2));
  } catch (e) {
    console.error("Erreur sauvegarde liens :", e.message);
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

loadLinks();

// ================= CACHE MEMBRES DU SERVEUR =================

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

// ================= CACHE DU GROUPE WA SELECTIONNE =================

let cachedGroupChat   = null;
let groupCacheAt      = 0;
const GROUP_CACHE_TTL = 60 * 1000;

function invalidateGroupCache() {
  cachedGroupChat = null;
  groupCacheAt    = 0;
}

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

function friendlyWaErrorReply(e) {
  console.error("Erreur WA (commande) :", e.message);
  if (isFatalWaError(e.message)) {
    restartWaClient("commande utilisateur: " + e.message);
    return "⚠️ WhatsApp semble déconnecté (crash Chrome/Puppeteer). Reconnexion automatique en cours, réessaie dans 10-15 secondes.";
  }
  return "❌ Erreur : " + e.message;
}

async function getSelectedGroup() {
  if (!selectedGroupId) return null;
  const now = Date.now();
  if (cachedGroupChat && (now - groupCacheAt) < GROUP_CACHE_TTL) return cachedGroupChat;
  try {
    const chat = await waClient.getChatById(selectedGroupId);
    cachedGroupChat = chat || null;
    groupCacheAt    = now;
    return cachedGroupChat;
  } catch (_) {
    cachedGroupChat = null;
    return null;
  }
}

function getContactName(contact) {
  return contact.name || contact.pushname || contact.number || "Inconnu";
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

// ================= SYNC PHOTO DE PROFIL =================

async function getContactAvatarUrl(contact) {
  const id = contact.id._serialized;
  if (avatarCache.has(id)) return avatarCache.get(id);
  try {
    const picUrl = await waClient.getProfilePicUrl(id);
    if (picUrl) {
      avatarCache.set(id, picUrl);
      return picUrl;
    }
  } catch (_) {}
  avatarCache.set(id, null);
  return null;
}

// ================= SYNC MENTIONS @ : WA -> DISCORD =================

async function convertWaMentionsToDiscord(text, mentionedIds) {
  if (!mentionedIds || mentionedIds.length === 0) return text;
  let result = text;
  for (const waId of mentionedIds) {
    const number = String(waId).split("@")[0];
    if (!number) continue;
    const mentionRegex = new RegExp("@" + number.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");

    const link = findLinkByWaNumber(number);

    console.log("Numéro détecté :", number);
    console.log("Lien trouvé :", link);

    if (link && link.discordId) {
      result = result.replace(mentionRegex, "<@" + link.discordId + ">");
      continue;
    }

    try {
      const contact = await waClient.getContactById(waId);
      if (!contact) continue;
      const name  = getContactName(contact);
      const guild = await getCachedGuildMembers();
      if (guild) {
        const nameLower = name.toLowerCase();
        const found = guild.members.cache.find((m) => {
          const nick = (m.nickname || "").toLowerCase();
          const user = m.user.username.toLowerCase();
          return nick.includes(nameLower) || nameLower.includes(nick) ||
                 user.includes(nameLower) || nameLower.includes(user);
        });
        if (found) {
          result = result.replace(mentionRegex, "<@" + found.id + ">");
          continue;
        }
      }
      result = result.replace(mentionRegex, name);
    } catch (_) {}
  }
  return result;
}

// ================= SYNC MENTIONS @ : DISCORD -> WHATSAPP =================

function convertDiscordMentionsToWa(content, mentionedUsers) {
  let result = content;
  const waMentionIds = [];
  if (!mentionedUsers || mentionedUsers.size === 0) return { text: result, mentions: waMentionIds };

  for (const [discordId] of mentionedUsers) {
    const link = findLinkByDiscordId(discordId);
    if (!link) continue;
    const waJid = link.waNumber + "@c.us";
    result = result.replace(new RegExp("<@!?" + discordId + ">", "g"), "@" + link.waNumber);
    waMentionIds.push(waJid);
  }
  return { text: result, mentions: waMentionIds };
}

// ================= @EVERYONE -> PING TOUT LE GROUPE WA =================

async function getAllGroupParticipantIds(group) {
  try {
    return (group.participants || []).map((p) => p.id._serialized);
  } catch (_) {
    return [];
  }
}

// ================= TRANSCRIPTION GROQ WHISPER =================

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
        "Authorization": "Bearer " + GROQ_API_KEY,
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
    console.error("Erreur transcription Groq :", e.message);
    return null;
  }
}

// ================= !txt : TRANSCRIPTION A LA DEMANDE =================

async function handleTxtCommand(msg, source) {
  if (source === "wa") {
    try {
      if (!msg.hasQuotedMsg) {
        await msg.reply("❌ Réponds à un message vocal avec !txt.");
        return;
      }

      let quoted;
      try {
        quoted = await msg.getQuotedMessage();
      } catch (e) {
        console.error("Erreur getQuotedMessage (!txt WA) :", e.message);
        await msg.reply("❌ Impossible de récupérer le message vocal cité (il est peut-être trop ancien). Réessaie avec un vocal plus récent.");
        return;
      }

      if (!quoted || (quoted.type !== "ptt" && quoted.type !== "audio")) {
        await msg.reply("❌ Le message cité n'est pas un message vocal.");
        return;
      }
      if (!quoted.hasMedia) {
        await msg.reply("❌ Ce message vocal n'a plus de média disponible (lien expiré).");
        return;
      }

      const media = await quoted.downloadMedia();
      if (!media) {
        await msg.reply("❌ Impossible de télécharger l'audio (média expiré ou indisponible).");
        return;
      }

      const { filepath } = saveMedia(media.data, media.mimetype, quoted.type);
      await msg.reply("⏳ Transcription en cours...");
      const transcript = await transcribeVoiceNote(filepath);
      if (transcript) {
        await msg.reply("🎙️ *Transcription :*\n" + transcript);
      } else {
        await msg.reply("❌ Impossible de transcrire ce message vocal (voir logs serveur pour le détail Groq).");
      }
    } catch (e) {
      console.error("Erreur !txt WA :", e.message);
      await msg.reply("❌ Erreur : " + e.message);
    }
  }

  if (source === "dc") {
    if (!msg.reference || !msg.reference.messageId) {
      await msg.reply("❌ Réponds à un message vocal (fichier audio) avec `!txt`.");
      return;
    }
    try {
      const channel  = await getDiscordChannel();
      const original = await channel.messages.fetch(msg.reference.messageId);
      const audioAtt = original.attachments.find((a) =>
        a.name && (a.name.endsWith(".ogg") || a.name.endsWith(".mp3") ||
                   a.name.endsWith(".m4a") || a.name.endsWith(".wav") ||
                   a.name.endsWith(".webm"))
      );
      if (!audioAtt) {
        await msg.reply("❌ Aucun fichier audio trouvé dans ce message.");
        return;
      }
      await msg.reply("⏳ Transcription en cours...");
      const res      = await fetch(audioAtt.url);
      const buffer   = await res.buffer();
      const filepath = MEDIA_DIR + "/" + Date.now() + "_" + audioAtt.name;
      fs.writeFileSync(filepath, buffer);
      const transcript = await transcribeVoiceNote(filepath);
      if (transcript) {
        await msg.reply("🎙️ **Transcription :**\n> " + transcript);
      } else {
        await msg.reply("❌ Impossible de transcrire ce message vocal.");
      }
    } catch (e) {
      await msg.reply("❌ Erreur : " + e.message);
    }
  }
}

// ================= SLASH COMMANDS =================

const commands = [
  new SlashCommandBuilder().setName("ping").setDescription("Vérifie la latence du bot"),
  new SlashCommandBuilder().setName("status").setDescription("Etat de la connexion WhatsApp et du groupe sélectionné"),
  new SlashCommandBuilder().setName("groupes").setDescription("Liste les groupes WhatsApp disponibles"),
  new SlashCommandBuilder()
    .setName("select")
    .setDescription("Sélectionne un groupe WhatsApp")
    .addIntegerOption((opt) => opt.setName("numero").setDescription("Numéro du groupe (voir /groupes)").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("Affiche la liste des commandes disponibles"),
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
    console.log("Slash commands enregistrees.");
  } catch (e) {
    console.error("Erreur enregistrement slash commands :", e.message);
  }
}

// ================= DISCORD =================

discordClient.once("clientReady", async () => {
  console.log("Discord connecte : " + discordClient.user.tag);
  await registerSlashCommands();
});

// ================= INTERACTIONS SLASH COMMANDS =================

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
      if (interaction.deferred || interaction.replied) {
        return await interaction.editReply(payload);
      }
      return await interaction.reply(payload);
    } catch (e) {
      console.error("Erreur reply interaction :", e.message);
    }
  };

  if (commandName === "ping") {
    const latency = Date.now() - interaction.createdTimestamp;
    await safeReply(`🏓 Pong ! Latence : **${latency}ms** | WebSocket : **${discordClient.ws.ping}ms**`);
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
      let discordId = interaction.user.id;
      let resolvedName = pseudo;

      if (guild) {
        const pseudoLower = pseudo.toLowerCase();
        const found = guild.members.cache.find((m) => {
          const nick = (m.nickname || "").toLowerCase();
          const user = m.user.username.toLowerCase();
          return user === pseudoLower || nick === pseudoLower;
        });
        if (found) {
          discordId    = found.id;
          resolvedName = found.user.username;
        }
      }

      setLink(discordId, resolvedName, numero);
      await safeReply({
        content: "✅ Lien créé : **" + resolvedName + "** ↔ **+" + numero + "**\nLes mentions `@` seront désormais correctement synchronisées entre Discord et WhatsApp.",
        ephemeral: true,
      });
    } catch (e) {
      await safeReply({ content: "❌ Erreur : " + e.message, ephemeral: true });
    }
    return;
  }

  if (commandName === "help") {
    await safeReply(
      "**Commandes slash :**\n" +
      "`/ping` — Latence du bot\n" +
      "`/groupes` — Liste les groupes WA\n" +
      "`/select <n>` — Sélectionne un groupe WA\n" +
      "`/status` — État de la connexion\n" +
      "`/link <pseudo> <numero>` — Lie ton pseudo Discord à ton numéro WhatsApp (sync des @)\n" +
      "`/help` — Cette aide\n\n" +
      "**Commandes `!` (Discord & WA) :**\n" +
      "`!txt` — Transcrit un message vocal (reply sur le vocal)\n" +
      "`!mute @Membre 2h` — Mute un membre (admins WA)\n" +
      "`!unmute @Membre` — Unmute un membre (admins WA)\n" +
      "`!groupes` / `!select <n>` / `!status` / `!help` — Commandes bridge"
    );
    return;
  }

  try {
    await interaction.deferReply();
  } catch (e) {
    console.error("Erreur deferReply :", e.message);
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
    } catch (e) { await safeReply("Erreur : " + e.message); }
    return;
  }

  if (commandName === "groupes") {
    try {
      const chats  = await waClient.getChats();
      const groups = chats.filter((c) => c.isGroup);
      if (!groups.length) { await safeReply("Aucun groupe trouvé."); return; }
      let txt = "**Groupes disponibles :**\n";
      groups.forEach((g, i) => { txt += `\`${i + 1}.\` ${g.name}\n`; });
      await safeReply(txt);
    } catch (e) { await safeReply(friendlyWaErrorReply(e)); }
    return;
  }

  if (commandName === "select") {
    try {
      const index  = interaction.options.getInteger("numero") - 1;
      const chats  = await waClient.getChats();
      const groups = chats.filter((c) => c.isGroup);
      if (isNaN(index) || !groups[index]) {
        await safeReply("❌ Numéro invalide. Utilise `/groupes`.");
        return;
      }
      selectedGroupId = groups[index].id._serialized;
      saveSelectedGroup();
      invalidateGroupCache();
      await safeReply(`✅ Groupe sélectionné : **${groups[index].name}**`);
    } catch (e) { await safeReply(friendlyWaErrorReply(e)); }
    return;
  }
});

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
  invalidateGroupCache();
  if (reason !== "LOGOUT") restartWaClient("disconnected: " + reason);
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
    const rawText  = msg.body || "";
    const senderId = contact.id._serialized;
    const group    = await getSelectedGroup();

    // !txt WA
    if (rawText.trim() === "!txt") {
      await handleTxtCommand(msg, "wa");
      return;
    }

    // COMMANDES ADMIN
    if (group && rawText.startsWith("!mute ")) {
      const adminCheck = await isGroupAdmin(contact, group);
      if (!adminCheck) {
        await group.sendMessage("❌ Seuls les admins peuvent utiliser !mute.", { quotedMessageId: waId });
        return;
      }
      const parts       = rawText.trim().split(/\s+/);
      const durationStr = parts[parts.length - 1];
      const durationMs  = parseDuration(durationStr);
      if (!durationMs) {
        await group.sendMessage("❌ Format invalide. Exemple : `!mute @Personne 2d`\nUnités : m (minutes), h (heures), d (jours)", { quotedMessageId: waId });
        return;
      }
      const target = await resolveMentionedContact(msg);
      if (!target) {
        await group.sendMessage("❌ Mentionne un membre avec @.", { quotedMessageId: waId });
        return;
      }
      const targetId      = target.id._serialized;
      const targetName    = getContactName(target);
      const targetIsAdmin = await isGroupAdmin(target, group);
      if (targetIsAdmin) {
        await group.sendMessage("❌ Impossible de muter un admin du groupe.", { quotedMessageId: waId });
        return;
      }
      const expireAt = Date.now() + durationMs;
      mutedUsers[targetId] = expireAt;
      saveMutes();
      log("MUTE", name, targetName + " mute jusqu'au " + formatExpire(expireAt));
      await group.sendMessage(
        "🔇 *" + targetName + "* est mute jusqu'au *" + formatExpire(expireAt) + "*.\n" +
        "Ses messages seront automatiquement supprimés.\n" +
        "Un admin peut le démuter avec `!unmute @" + targetName + "`.",
        { quotedMessageId: waId }
      );
      return;
    }

    if (group && rawText.startsWith("!unmute ")) {
      const adminCheck = await isGroupAdmin(contact, group);
      if (!adminCheck) {
        await group.sendMessage("❌ Seuls les admins peuvent utiliser !unmute.", { quotedMessageId: waId });
        return;
      }
      const target = await resolveMentionedContact(msg);
      if (!target) {
        await group.sendMessage("❌ Mentionne un membre avec @.", { quotedMessageId: waId });
        return;
      }
      const targetId   = target.id._serialized;
      const targetName = getContactName(target);
      if (mutedUsers[targetId]) {
        delete mutedUsers[targetId];
        saveMutes();
        log("UNMUTE", name, targetName + " demute par " + name);
        await group.sendMessage("🔊 *" + targetName + "* a été démuté par *" + name + "*.\nIl peut de nouveau envoyer des messages.", { quotedMessageId: waId });
      } else {
        await group.sendMessage("ℹ️ *" + targetName + "* n'est pas mute.", { quotedMessageId: waId });
      }
      return;
    }

    // FILTRAGE MUTE
    if (isMuted(senderId)) {
      log("MUTE_BLOCK", name, "Message supprime (mute actif)");
      try { await msg.delete(true); } catch (e) {
        console.error("Erreur suppression message mute :", e.message);
      }
      return;
    }

    // SYNC PP
    const avatarUrl = await getContactAvatarUrl(contact);

    // SYNC MENTIONS
    let text = rawText;
    if (msg.mentionedIds && msg.mentionedIds.length > 0) {
      text = await convertWaMentionsToDiscord(text, msg.mentionedIds);
    }

    // MESSAGES VOCAUX
    if (msg.type === "ptt" || msg.type === "audio") {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          const { filename, filepath } = saveMedia(media.data, media.mimetype, msg.type);
          const transcript = await transcribeVoiceNote(filepath);
          const webhookOptions = {
            username: name,
            content:  transcript ? `🎙️ *Message vocal :*\n> ${transcript}` : "🎙️ *Message vocal* — réponds avec `!txt` pour transcrire",
            files: [{ attachment: filepath, name: filename }],
          };
          if (avatarUrl) webhookOptions.avatarURL = avatarUrl;
          const sent = await webhook.send(webhookOptions);
          waToDiscord.set(waId, sent.id);
          discordToWa.set(sent.id, waId);
        }
      } catch (e) { console.error("Erreur message vocal WA->DC :", e.message); }
      return;
    }

    // AUTRES MEDIAS
    const MAX_DISCORD_FILE_SIZE = 8 * 1024 * 1024;
    const files = [];

    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          const sizeBytes = Math.ceil(media.data.length * 0.75);
          if (sizeBytes > MAX_DISCORD_FILE_SIZE) {
            log("MEDIA_SKIP", name, "Fichier trop lourd (" + Math.round(sizeBytes / 1024 / 1024) + " MB)");
          } else {
            const { filename, filepath } = saveMedia(media.data, media.mimetype, msg.type);
            files.push({ attachment: filepath, name: filename });
          }
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

    log("WA->DC", name, rawText || "[MEDIA]");

    const webhookOptions = { username: name, content: finalContent || " ", files };
    if (avatarUrl) webhookOptions.avatarURL = avatarUrl;

    const sent = await webhook.send(webhookOptions);
    waToDiscord.set(waId, sent.id);
    discordToWa.set(sent.id, waId);

  } catch (e) { console.error("Erreur WA->DC :", e.message); }
});

// ================= WHATSAPP : !txt POUR LES MESSAGES ENVOYES PAR SOI-MEME =================

waClient.on("message_create", async (msg) => {
  try {
    if (!waReady) return;
    if (!msg.fromMe) return;
    if (!msg.from.endsWith("@g.us")) return;
    if (selectedGroupId && msg.from !== selectedGroupId) return;
    if (msg.timestamp < startTimestamp) return;

    const rawText = (msg.body || "").trim();
    if (rawText !== "!txt") return;

    sentByBridge.add(msg.id._serialized);
    await handleTxtCommand(msg, "wa");
  } catch (e) {
    console.error("Erreur message_create (!txt self) :", e.message);
  }
});

// ================= WHATSAPP : EDITION =================

waClient.on("message_edit", async (msg) => {
  const discordId = waToDiscord.get(msg.id._serialized);
  if (!discordId) return;
  try {
    const contact = await msg.getContact();
    if (!contact) return;
    const name = getContactName(contact);
    await webhook.editMessage(discordId, { content: name + " : " + (msg.body || "[MEDIA]") + " *(édité)*" });
  } catch (e) {
    if (!e.message.includes("Unknown Message")) console.error("Erreur edition WA->DC :", e.message);
  }
});

// ================= WHATSAPP : SUPPRESSION =================

waClient.on("message_revoke_everyone", async (_, revokedMsg) => {
  if (!revokedMsg) return;
  const discordId = waToDiscord.get(revokedMsg.id._serialized);
  if (!discordId) return;
  try {
    await webhook.deleteMessage(discordId);
  } catch (e) {
    if (!e.message.includes("Unknown Message")) console.error("Erreur suppression WA->DC :", e.message);
  }
});

// ================= DISCORD -> WHATSAPP =================

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

  // !txt Discord
  if (content.trim() === "!txt") {
    await handleTxtCommand(message, "dc");
    return;
  }

  // COMMANDES ! Discord
  if (content === "!groupes") {
    try {
      const chats  = await waClient.getChats();
      const groups = chats.filter((c) => c.isGroup);
      if (!groups.length) { await message.reply("Aucun groupe trouvé."); return; }
      let txt = "Groupes disponibles :\n";
      groups.forEach((g, i) => { txt += (i + 1) + ". " + g.name + "\n"; });
      await message.reply(txt);
    } catch (e) { await message.reply(friendlyWaErrorReply(e)); }
    return;
  }

  if (content.startsWith("!select ")) {
    try {
      const index  = parseInt(content.split(" ")[1], 10) - 1;
      const chats  = await waClient.getChats();
      const groups = chats.filter((c) => c.isGroup);
      if (isNaN(index) || !groups[index]) {
        await message.reply("Numéro invalide. Utilise /groupes.");
        return;
      }
      selectedGroupId = groups[index].id._serialized;
      saveSelectedGroup();
      invalidateGroupCache();
      await message.reply("Groupe sélectionné : " + groups[index].name);
    } catch (e) { await message.reply(friendlyWaErrorReply(e)); }
    return;
  }

  if (content === "!status") {
    try {
      const group = await getSelectedGroup();
      await message.reply(waReady ? "WhatsApp connecté\nGroupe : " + (group ? group.name : "aucun sélectionné") : "WhatsApp non connecté");
    } catch (e) { console.error("Erreur !status :", e.message); }
    return;
  }

  if (content === "!help") {
    await message.reply(
      "Commandes disponibles :\n" +
      "`!txt` — Transcrit un message vocal (reply sur le message audio)\n" +
      "`!groupes` — Liste les groupes WA\n" +
      "`!select <n>` — Sélectionne un groupe WA\n" +
      "`!status` — Etat connexion\n" +
      "`!help` — Cette aide\n" +
      "Slash : `/ping` `/groupes` `/select` `/status` `/link` `/help`"
    );
    return;
  }

  // BRIDGE DC -> WA
  const group = await getSelectedGroup();
  if (!group) {
    await message.reply("Aucun groupe sélectionné. Utilise `/select <n>`.");
    return;
  }

  const replyOptions = {};
  if (message.reference && message.reference.messageId) {
    const quotedWaId = discordToWa.get(message.reference.messageId);
    if (quotedWaId) replyOptions.quotedMessageId = quotedWaId;
  }

  // @HERE : ignore complet
  if (content && content.includes("@here")) {
    log("DC->WA_BLOCKED", name, "Message ignore (contient @here) : " + content);
    return;
  }

  if (content && !content.startsWith("!")) {
    try {
      let { text: waContent, mentions } = convertDiscordMentionsToWa(content, message.mentions.users);

      // @EVERYONE : WhatsApp ne ping que si le texte contient "@<numero>" correspondant aux JIDs dans `mentions`.
      // On ajoute donc "@all" visible + tous les "@<numero>" des participants pour declencher un vrai ping global.
      if (content.includes("@everyone")) {
        const allIds = await getAllGroupParticipantIds(group);
        const pingIds = allIds.filter((id) => id.endsWith("@c.us") || id.endsWith("@lid"));
        const pingTags = pingIds.map((id) => "@" + id.split("@")[0]).join(" ");
        waContent = waContent.replace(/@everyone/g, "@all " + pingTags);
        mentions = Array.from(new Set([...mentions, ...pingIds]));
      }

      const sendOptions = Object.assign({}, replyOptions, mentions.length ? { mentions } : {});
      const sent = await group.sendMessage("*" + name + "* : " + waContent, sendOptions);
      if (sent) {
        sentByBridge.add(sent.id._serialized);
        waToDiscord.set(sent.id._serialized, message.id);
        discordToWa.set(message.id, sent.id._serialized);
        log("DC->WA", name, waContent);
      } else {
        log("DC->WA_FAIL", name, "sendMessage retourne null | msg: " + content);
      }
    } catch (e) {
      log("DC->WA_ERROR", name, "ERREUR: " + e.message + " | msg: " + content);
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
        log("DC->WA", name, "[MEDIA] " + att.name);
      } else {
        log("DC->WA_FAIL", name, "sendMessage media retourne null | fichier: " + att.name);
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

discordClient.login(DISCORD_TOKEN)
  .then(() => console.log("Connexion Discord lancée"))
  .catch(console.error);

waClient.initialize();