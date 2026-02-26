// ================= IMPORTS =================
const { Client: DiscordClient, GatewayIntentBits } = require("discord.js");
const { Client: WhatsAppClient, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

// ================= CONFIG =================
const DISCORD_TOKEN = "TON_DISCORD_TOKEN";
const DISCORD_CHANNEL_ID = "ID_DU_CHANNEL_DISCORD";

// ================= VARIABLES =================
const discordClient = new DiscordClient({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const whatsappClient = new WhatsAppClient({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    }
});

let whatsappReady = false;
let whatsappGroups = [];
let targetGroup = null;

// ========== UTILISATEURS ACCEPTES ==========
const acceptFilePath = path.join(__dirname, "usersAccepted.json");
let usersAccepted = new Set();

// Charge les utilisateurs depuis le fichier
if (fs.existsSync(acceptFilePath)) {
    const data = fs.readFileSync(acceptFilePath, "utf-8");
    try {
        const list = JSON.parse(data);
        usersAccepted = new Set(list);
        console.log(`Utilisateurs acceptes charges: ${list.length}`);
    } catch (err) {
        console.error("Erreur lecture usersAccepted.json :", err);
    }
}

// Sauvegarde dans le fichier
function saveUsersAccepted() {
    fs.writeFileSync(acceptFilePath, JSON.stringify([...usersAccepted], null, 2));
}

// ================= WHATSAPP =================
whatsappClient.on("qr", qr => {
    qrcode.generate(qr, { small: true });
    console.log("Scanne ce QR code avec WhatsApp !");
});

whatsappClient.on("ready", async () => {
    whatsappReady = true;
    console.log("WhatsApp pret !");
    const chats = await whatsappClient.getChats();
    whatsappGroups = chats.filter(c => c.isGroup);
    console.log(`Groupes WhatsApp charges: ${whatsappGroups.length}`);
});

whatsappClient.on("message", msg => {
    console.log(`Message WhatsApp recu de ${msg.from}: ${msg.body}`);
});

whatsappClient.initialize();

// ================= DISCORD =================
discordClient.on("ready", () => {
    console.log(`Discord connecte : ${discordClient.user.tag}`);
});

discordClient.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.channel.id !== DISCORD_CHANNEL_ID) return;

    // ========== ACCEPTATION DES CONDITIONS ==========
    if (!usersAccepted.has(message.author.id)) {
        if (message.content.toLowerCase() === "!accepte") {
            usersAccepted.add(message.author.id);
            saveUsersAccepted();
            return message.reply("Merci, vous avez accepte les conditions. Vous pouvez maintenant utiliser les commandes et envoyer des messages vers WhatsApp.");
        } else {
            return message.reply(
`Vous devez accepter les conditions avant d'utiliser le bot

Conditions de linterface WhatsApp:
- Pas de spam (1 message toutes les 5 secondes max)
- Linterface WhatsApp est uniquement pour parler de lecole
- Les messages inutiles ou hors sujet sont interdits
- Contenu illegal ou inapproprie interdit
- Aucune insulte ne sera toleree

Tapez !accepte pour accepter.`
            );
        }
    }

    // ========== COMMANDES POUR LES GROUPES ==========
    const content = message.content.trim();

    if (content.toLowerCase() === "!groupes") {
        if (!whatsappReady) return message.reply("WhatsApp n'est pas pret.");
        if (whatsappGroups.length === 0) return message.reply("Aucun groupe trouve.");
        let reply = "Liste des groupes WhatsApp:\n";
        whatsappGroups.forEach((g, i) => {
            reply += `${i + 1}. ${g.name}\n`;
        });
        return message.reply(reply);
    }

    if (content.toLowerCase().startsWith("!select ")) {
        const args = content.split(" ");
        const index = parseInt(args[1], 10);
        if (isNaN(index) || index < 1 || index > whatsappGroups.length) {
            return message.reply("Numero de groupe invalide.");
        }
        targetGroup = whatsappGroups[index - 1];
        return message.reply(`Groupe WhatsApp selectionne: ${targetGroup.name}`);
    }

    // ========== RELAIS AUTOMATIQUE ==========
    if (!whatsappReady || !targetGroup) {
        return message.reply("WhatsApp n'est pas pret ou aucun groupe n'est selectionne.");
    }

    try {
        await whatsappClient.sendMessage(targetGroup.id._serialized, `${message.author.username}: ${message.content}`);
        console.log(`Relais Discord -> WhatsApp : ${message.content}`);
    } catch (err) {
        console.error("Erreur lors de l'envoi vers WhatsApp :", err);
        message.reply("Une erreur est survenue lors de l'envoi vers WhatsApp.");
    }
});

discordClient.login(DISCORD_TOKEN);