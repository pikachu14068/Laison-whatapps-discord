// ================= IMPORTS =================
const fs = require('fs');
const { Client: DiscordClient, GatewayIntentBits } = require('discord.js');
const { Client: WhatsAppClient, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');

// ================= CONFIG =================
const DISCORD_TOKEN = 'TON_TOKEN_ICI';
const DISCORD_CHANNEL_ID = 'TON_CHANNEL_ID_ICI';
const USERS_FILE = './accepted_users.json';

let selectedGroupId = null;
let isWhatsappReady = false;

// ================= UTILISATEURS =================
let usersAccepted = new Set();

if (fs.existsSync(USERS_FILE)) {
    usersAccepted = new Set(JSON.parse(fs.readFileSync(USERS_FILE)));
}

function saveUsers() {
    fs.writeFileSync(USERS_FILE, JSON.stringify([...usersAccepted]));
}

// ================= WHATSAPP =================
const whatsappClient = new WhatsAppClient({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

whatsappClient.on('qr', async (qr) => {
    try {
        const qrBuffer = await QRCode.toBuffer(qr);
        const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);

        await channel.send({
            content: 'Scanne ce QR code avec WhatsApp :',
            files: [{ attachment: qrBuffer, name: 'whatsapp-qr.png' }]
        });

        console.log('QR envoye sur Discord');
    } catch (err) {
        console.error('Erreur QR:', err);
    }
});

whatsappClient.on('ready', () => {
    console.log('WhatsApp pret');
    isWhatsappReady = true;
});

// ================= DISCORD =================
const discordClient = new DiscordClient({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

discordClient.once('ready', () => {
    console.log('Discord connecte');
});

// ================= DISCORD → WHATSAPP =================
discordClient.on('messageCreate', async (message) => {

    if (message.author.bot) return;

    const content = message.content.trim();
    const pseudoDiscord = message.member?.displayName || message.author.username;

    // ===== !accepte =====
    if (!usersAccepted.has(message.author.id)) {
        if (content === '!accepte') {
            usersAccepted.add(message.author.id);
            saveUsers();
            return message.reply('Conditions acceptees.');
        }
        return message.reply('Tape !accepte pour utiliser le bot.');
    }

    // ===== !groupes =====
    if (content === '!groupes') {

        if (!isWhatsappReady)
            return message.reply('WhatsApp pas pret.');

        const chats = await whatsappClient.getChats();
        const groups = chats.filter(c => c.isGroup);

        if (!groups.length)
            return message.reply('Aucun groupe trouve.');

        let reply = 'Groupes WhatsApp :\n';
        groups.forEach((g, i) => {
            reply += `${i + 1}. ${g.name}\n`;
        });

        return message.reply(reply);
    }

    // ===== !select X =====
    if (content.startsWith('!select ')) {

        if (!isWhatsappReady)
            return message.reply('WhatsApp pas pret.');

        const index = parseInt(content.split(' ')[1]) - 1;

        const chats = await whatsappClient.getChats();
        const groups = chats.filter(c => c.isGroup);

        if (!groups[index])
            return message.reply('Numero invalide.');

        selectedGroupId = groups[index].id._serialized;

        return message.reply(`Groupe selectionne : ${groups[index].name}`);
    }

    // ===== ENVOI NORMAL =====
    if (!selectedGroupId || !isWhatsappReady) return;

    try {

        // TEXTE
        if (content) {
            await whatsappClient.sendMessage(
                selectedGroupId,
                `${pseudoDiscord} : ${content}`
            );
        }

        // FICHIERS
        for (const attachment of message.attachments.values()) {

            const media = await MessageMedia.fromUrl(attachment.url);

            // STICKER
            if (
                attachment.name.endsWith('.webp') ||
                attachment.contentType === 'image/webp'
            ) {
                await whatsappClient.sendMessage(selectedGroupId, media, {
                    sendMediaAsSticker: true
                });
            }

            // IMAGE
            else if (attachment.contentType?.startsWith('image')) {
                await whatsappClient.sendMessage(selectedGroupId, media, {
                    caption: `${pseudoDiscord} : [Image]`
                });
            }

            // VIDEO
            else if (attachment.contentType?.startsWith('video')) {
                await whatsappClient.sendMessage(selectedGroupId, media, {
                    caption: `${pseudoDiscord} : [Video]`
                });
            }

            // AUTRE FICHIER
            else {
                await whatsappClient.sendMessage(selectedGroupId, media, {
                    caption: `${pseudoDiscord} : [Fichier]`
                });
            }
        }

    } catch (err) {
        console.error('Erreur Discord -> WA:', err);
    }
});

// ================= WHATSAPP → DISCORD =================
whatsappClient.on('message', async (msg) => {

    if (!msg.from.includes('@g.us')) return;
    if (!selectedGroupId) return;
    if (msg.from !== selectedGroupId) return;

    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);

    try {

        const contact = await msg.getContact();
        const pseudo =
            contact.pushname ||
            contact.name ||
            contact.number ||
            "Utilisateur";

        // TEXTE
        if (msg.body && !msg.hasMedia) {
            await channel.send(`${pseudo} : ${msg.body}`);
        }

        // MEDIA
        if (msg.hasMedia) {

            const media = await msg.downloadMedia();
            if (!media) return;

            const buffer = Buffer.from(media.data, 'base64');

            if (msg.type === 'sticker') {
                await channel.send({
                    content: `${pseudo} : [Sticker]`,
                    files: [{ attachment: buffer, name: 'sticker.webp' }]
                });
            }

            else if (msg.type === 'image') {
                await channel.send({
                    content: `${pseudo} : [Image]`,
                    files: [{ attachment: buffer, name: 'image.jpg' }]
                });
            }

            else if (msg.type === 'video') {
                await channel.send({
                    content: `${pseudo} : [Video]`,
                    files: [{ attachment: buffer, name: 'video.mp4' }]
                });
            }

            else {
                await channel.send({
                    content: `${pseudo} : [Fichier]`,
                    files: [{ attachment: buffer, name: 'media' }]
                });
            }
        }

    } catch (err) {
        console.error('Erreur WA -> Discord:', err);
    }
});

// ================= START =================
whatsappClient.initialize();
discordClient.login(DISCORD_TOKEN);