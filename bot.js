// ================= IMPORTS =================
import pkg from 'whatsapp-web.js';
const { Client: WhatsAppClient, LocalAuth, MessageMedia } = pkg;
import { Client, GatewayIntentBits } from 'discord.js';
import puppeteer from 'puppeteer';
import qrcode from 'qrcode-terminal';
import fs from 'fs';

// ================= CONFIG =================
const DISCORD_TOKEN = "token bot";
const DISCORD_CHANNEL_ID = "id salon";
const DATA_FILE = "./accepted.json";
const CONDITIONS = `
Conditions de l'interface WhatsApp

Merci de respecter les rÃ¨gles suivantes :

- Pas de spam (1 message toutes les 3 secondes max)
- Interface uniquement pour le groupe prÃ©vu
- Messages inutiles interdits
- Contenu illÃ©gal interdit
- Insultes interdites

Tape !accepte pour continuer
`;

// ================= GLOBALS =================
let TARGET_GROUP_ID = null;
let groupsCache = [];
let whatsappReady = false;
let lastMsg = {};

// ================= ACCEPTED USERS =================
function loadAccepted() {
    if (!fs.existsSync(DATA_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE));
    } catch {
        return {};
    }
}
function saveAccepted(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ================= ANTI SPAM =================
function canSend(id) {
    const now = Date.now();
    if (!lastMsg[id] || now - lastMsg[id] > 3000) {
        lastMsg[id] = now;
        return true;
    }
    return false;
}

// ================= DISCORD CLIENT =================
const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

discord.once("clientReady", () => {
    console.log("Discord connectÃ© :", discord.user.tag);
});

// ================= WHATSAPP CLIENT =================
const whatsapp = new WhatsAppClient({
    authStrategy: new LocalAuth({ clientId: "bot-stable" }),
    puppeteer: {
        headless: true,
        executablePath: puppeteer.executablePath(),
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    }
});

whatsapp.on("qr", qr => {
    console.log("Scan ce QR Code WhatsApp :");
    qrcode.generate(qr, { small: true });
});

whatsapp.on("ready", () => {
    whatsappReady = true;
    console.log("WhatsApp connectÃ© !");
});

// ================= DISCORD -> WHATSAPP =================
discord.on("messageCreate", async message => {
    if (message.author.bot) return;
    if (message.channel.id !== DISCORD_CHANNEL_ID) return;

    const accepted = loadAccepted();

    if (message.content === "!accepte") {
        accepted[message.author.id] = true;
        saveAccepted(accepted);
        return message.reply("Conditions acceptÃ©es !");
    }

    if (!accepted[message.author.id]) {
        return message.reply(CONDITIONS);
    }

    // Gestion des groupes
    if (message.content === "!groupes") {
        if (!whatsappReady) return message.reply("WhatsApp pas prÃªt");
        const chats = await whatsapp.getChats();
        groupsCache = chats.filter(c => c.isGroup);
        let txt = "Groupes WhatsApp disponibles :\n";
        groupsCache.forEach((g, i) => txt += `${i + 1} - ${g.name}\n`);
        txt += "\nTape !select X pour choisir";
        return message.reply(txt);
    }

    if (message.content.startsWith("!select")) {
        const i = parseInt(message.content.split(" ")[1]) - 1;
        if (!groupsCache[i]) return message.reply("Mauvais numÃ©ro");
        TARGET_GROUP_ID = groupsCache[i].id._serialized;
        return message.reply(`Groupe sÃ©lectionnÃ© : ${groupsCache[i].name}`);
    }

    if (!TARGET_GROUP_ID) return;

    if (!canSend(message.author.id)) return;

    const pseudo =
        message.member?.nickname ||
        message.author.globalName ||
        message.author.username;

    let content = message.content;

    for (const [id, user] of message.mentions.users) {
        const name = user.globalName || user.username;
        content = content.replace(new RegExp(`<@!?${id}>`, "g"), `@${name}`);
    }

    if (message.reference) {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        const refName =
            ref.member?.nickname ||
            ref.author.globalName ||
            ref.author.username;
        let snippet = ref.content.length > 50 ? ref.content.slice(0, 50) + "..." : ref.content;
        content = `${refName}: "${snippet}"\nDiscord | ${pseudo}: ${content}`;
    }

    await whatsapp.sendMessage(TARGET_GROUP_ID, content);
});

// ================= WHATSAPP -> DISCORD =================
whatsapp.on("message", async msg => {
    if (!TARGET_GROUP_ID) return;
    if (msg.from !== TARGET_GROUP_ID) return;

    const channel = await discord.channels.fetch(DISCORD_CHANNEL_ID);
    if (!channel) return;

    const contact = await msg.getContact();
    const sender = contact.pushname || contact.name || contact.number;

    if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        const buffer = Buffer.from(media.data, "base64");

        if (media.mimetype.startsWith("audio")) {
            return channel.send({ files: [{ attachment: buffer, name: "vocal.ogg" }] });
        }

        return channel.send({ files: [{ attachment: buffer, name: media.filename || "media" }] });
    }

    let body = msg.body || "";
    if (msg.hasQuotedMsg) {
        const q = await msg.getQuotedMessage();
        body = `SELECT: "${q.body}"\n${body}`;
    }

    channel.send(`${sender}: ${body}`);
});

// ================= START =================
(async () => {
    await discord.login(DISCORD_TOKEN);
    await whatsapp.initialize();
})();