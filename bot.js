// ================= IMPORTS =================
const { Client: DiscordClient, GatewayIntentBits } = require("discord.js");
const { Client: WhatsAppClient, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

// ================= CONFIG =================
const DISCORD_TOKEN = "TON_DISCORD_BOT_TOKEN";
const WHATSAPP_MEDIA_FOLDER = path.join(__dirname, "media");
const USERS_ACCEPT_FILE = path.join(__dirname, "usersAccepted.json");

// ================= INIT =================
if (!fs.existsSync(WHATSAPP_MEDIA_FOLDER)) fs.mkdirSync(WHATSAPP_MEDIA_FOLDER);
let usersAccepted = new Set();
if (fs.existsSync(USERS_ACCEPT_FILE)) {
    usersAccepted = new Set(JSON.parse(fs.readFileSync(USERS_ACCEPT_FILE, "utf8")));
}

// ================= CLIENTS =================
const discordClient = new DiscordClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

const whatsappClient = new WhatsAppClient({
    authStrategy: new LocalAuth({ clientId: "bot-whatsapp" }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let whatsappReady = false;
let whatsappGroups = [];
let selectedGroupId = null;

// ================= WHATSAPP =================
whatsappClient.on("qr", qr => {
    console.log("QR WhatsApp:");
    qrcode.generate(qr, { small: true });
});

whatsappClient.on("ready", async () => {
    console.log("WhatsApp pret !");
    whatsappReady = true;

    // Charger la liste des groupes
    const chats = await whatsappClient.getChats();
    whatsappGroups = chats.filter(c => c.isGroup);
    if (whatsappGroups.length) {
        console.log("Groupes WhatsApp disponibles:");
        whatsappGroups.forEach((g, i) => console.log(`${i + 1}. ${g.name}`));
    } else {
        console.log("Aucun groupe WhatsApp trouve.");
    }
});

whatsappClient.initialize();

// ================= DISCORD =================
discordClient.on("ready", () => {
    console.log(`Discord connecte : ${discordClient.user.tag}`);
});

// ================= UTILITAIRES =================
async function downloadAttachment(url, folder) {
    const fileName = path.basename(url);
    const filePath = path.join(folder, fileName);
    const response = await axios({ url, method: "GET", responseType: "stream" });
    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);
    await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
    });
    return filePath;
}

// ================= DISCORD MESSAGE =================
discordClient.on("messageCreate", async message => {
    if (message.author.bot) return;

    const msg = message.content.trim();
    const args = msg.split(" ");
    const command = args.shift().toLowerCase();

    // =========== COMMANDES CONDITIONS ===========
    if (!usersAccepted.has(message.author.id)) {
        if (command === "!accepte") {
            usersAccepted.add(message.author.id);
            fs.writeFileSync(USERS_ACCEPT_FILE, JSON.stringify([...usersAccepted]));
            return message.reply("Merci, vous avez accepte les conditions. Vous pouvez maintenant utiliser le bot.");
        } else {
            return message.reply(
`Vous devez accepter les conditions avant d'utiliser le bot

**Conditions de l'interface WhatsApp**:

- Pas de spam
- 1 message toutes les 5 secondes maximum
- L'interface WhatsApp est uniquement pour parler de l'ecole
- Les messages hors sujet ou inutiles sont interdits
- Aucun contenu illegal ou inapproprie est tolere
- Aucune insulte n'est autorisee

Tapez "!accepte" pour accepter.`)
        }
    }

    // =========== COMMANDES GROUPES ===========
    if (command === "!groupes") {
        if (!whatsappGroups.length) return message.reply("Aucun groupe WhatsApp disponible.");
        let list = whatsappGroups.map((g, i) => `${i + 1}. ${g.name}`).join("\n");
        return message.reply(`Liste des groupes WhatsApp:\n${list}`);
    }

    if (command === "!select") {
        const index = parseInt(args[0]);
        if (!index || index < 1 || index > whatsappGroups.length) return message.reply("Numero de groupe invalide.");
        selectedGroupId = whatsappGroups[index - 1].id._serialized;
        return message.reply(`Groupe WhatsApp selectionne : ${whatsappGroups[index - 1].name}`);
    }

    // =========== ENVOI AUTOMATIQUE ===========
    if (!whatsappReady) return message.reply("WhatsApp n'est pas encore pret.");

    if (!selectedGroupId) return message.reply("Vous devez selectionner un groupe WhatsApp avec !select X");

    try {
        // Gestion des fichiers joints
        if (message.attachments.size > 0) {
            for (const attachment of message.attachments.values()) {
                const filePath = await downloadAttachment(attachment.url, WHATSAPP_MEDIA_FOLDER);
                const media = MessageMedia.fromFilePath(filePath);
                await whatsappClient.sendMessage(selectedGroupId, media);
                console.log(`Envoye ${attachment.name} sur WhatsApp`);
            }
        }

        // Gestion message texte
        if (msg && !msg.startsWith("!")) {
            await whatsappClient.sendMessage(selectedGroupId, msg);
            console.log(`Envoye texte sur WhatsApp: ${msg}`);
        }

    } catch (err) {
        console.error("Erreur en envoyant le message sur WhatsApp:", err);
    }
});

// ================= LANCEMENT =================
discordClient.login(DISCORD_TOKEN);