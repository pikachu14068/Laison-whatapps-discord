// ================= IMPORTS =================
const fs = require('fs');
const path = require('path');
const { Client: DiscordClient, GatewayIntentBits } = require('discord.js');
const { Client: WhatsAppClient, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');

// ================= CONFIG =================
const DISCORD_TOKEN = 'Ton token';
const DISCORD_CHANNEL_ID = 'Ton discord ID';
const MEDIA_DIR = './media';
const WHATSAPP_SESSION_DIR = './whatsapp-session';

if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

let selectedGroupId = null;

// ================= CLIENT WHATSAPP =================
const whatsappClient = new WhatsAppClient({
    authStrategy: new LocalAuth({ clientId: 'bot-whatsapp' }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

// ================= CLIENT DISCORD =================
const discordClient = new DiscordClient({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ================= QR CODE =================
whatsappClient.on('qr', async (qr) => {
    console.log('QR WhatsApp genere:');

    // Génère le QR en console pour debug
    require('qrcode-terminal').generate(qr, { small: true });

    // Génère le QR code en image PNG
    const dataUrl = await QRCode.toDataURL(qr);
    // Converti base64 -> buffer
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    const channel = discordClient.channels.cache.get(DISCORD_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
        await channel.send({ content: 'Voici le QR code pour WhatsApp :', files: [{ attachment: buffer, name: 'whatsapp_qr.png' }] });
        console.log('QR code image envoye sur Discord !');
    }
});
// ================= READY =================
whatsappClient.on('ready', () => console.log('WhatsApp pret !'));
discordClient.once('ready', () => console.log('Discord connecte !'));

// ================= UTILITAIRES =================
function saveMedia(data, ext, prefix='file') {
    const buffer = Buffer.from(data, 'base64');
    const filename = `${prefix}_${Date.now()}.${ext}`;
    const filepath = path.join(MEDIA_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    return filepath;
}

// ================= WHATSAPP -> DISCORD =================
whatsappClient.on('message', async (msg) => {
    try {
        if (!selectedGroupId) return;
        if (msg.from !== selectedGroupId) return;

        const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID);
        const contact = await msg.getContact();
        const pseudo = contact.pushname || contact.name || contact.number || "Utilisateur";

        // TEXTE
        if (msg.body && !msg.hasMedia) {
            await channel.send(`${pseudo}: ${msg.body}`);
        }

        // MEDIA
        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (!media) return;

            let ext = 'dat';
            if (msg.type === 'image') ext = 'png';
            if (msg.type === 'video') ext = 'mp4';
            if (msg.type === 'audio' || msg.type === 'ptt') ext = 'ogg';
            if (msg.type === 'sticker') ext = 'webp';

            const filePath = saveMedia(media.data, ext, msg.type);

            const labelMap = { 'ptt':'[Vocal]', 'audio':'[Audio]', 'video':'[Video]', 'image':'[Image]', 'sticker':'[Sticker]' };
            const label = labelMap[msg.type] || '[Fichier]';

            await channel.send({ content: `${pseudo}: ${label}`, files: [filePath] });
        }

    } catch (err) { console.error('Erreur WA -> Discord:', err); }
});

// ================= DISCORD -> WHATSAPP =================
discordClient.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!selectedGroupId || !whatsappClient.info) return;

    const content = message.content.trim();
    await whatsappClient.sendMessage(selectedGroupId, `${message.author.username}: ${content}`);

    // Fichiers attaches
    if (message.attachments.size > 0) {
        for (const attachment of message.attachments.values()) {
            try {
                const media = await MessageMedia.fromUrl(attachment.url);
                await whatsappClient.sendMessage(selectedGroupId, media);
            } catch(err) {
                console.error('Erreur en envoyant media Discord -> WhatsApp:', err);
            }
        }
    }
});

// ================= COMMANDES GROUPES =================
discordClient.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const content = message.content.trim();

    if (content === '!groupes') {
        if (!whatsappClient.info) return message.reply('WhatsApp pas encore pret.');
        const chats = await whatsappClient.getChats();
        const groups = chats.filter(c => c.isGroup);
        if (groups.length === 0) return message.reply('Aucun groupe WhatsApp trouve.');
        let reply = 'Groupes WhatsApp disponibles:\n';
        groups.forEach((g, i) => reply += `${i+1}. ${g.name}\n`);
        return message.reply(reply);
    }

    if (content.startsWith('!select ')) {
        if (!whatsappClient.info) return message.reply('WhatsApp pas encore pret.');
        const chats = await whatsappClient.getChats();
        const groups = chats.filter(c => c.isGroup);
        const index = parseInt(content.split(' ')[1])-1;
        if (isNaN(index) || index < 0 || index >= groups.length) return message.reply('Numero invalide.');
        selectedGroupId = groups[index].id._serialized;
        return message.reply(`Groupe WhatsApp selectionne: ${groups[index].name}`);
    }
});

// ================= DEMARRAGE =================
whatsappClient.initialize();
discordClient.login(DISCORD_TOKEN);