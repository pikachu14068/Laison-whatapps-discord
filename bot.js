// ================= IMPORTS =================
const fs = require('fs')
const path = require('path')
const { Client: DiscordClient, GatewayIntentBits } = require('discord.js')
const { Client: WhatsAppClient, LocalAuth, MessageMedia } = require('whatsapp-web.js')
const QRCode = require('qrcode')
const qrcodeTerminal = require('qrcode-terminal')

// ================= CONFIG =================
const DISCORD_TOKEN = "TON_TOKEN_DISCORD"
const DISCORD_CHANNEL_ID = "TON_CHANNEL_ID"

const MEDIA_DIR = "./media"
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR)

// ================= VARIABLES =================
let selectedGroupId = null
const messageMap = new Map()

// ================= DISCORD =================
const discordClient = new DiscordClient({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
})

// ================= WHATSAPP =================
const whatsappClient = new WhatsAppClient({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox']
    }
})

// ================= QR CODE =================
whatsappClient.on('qr', async (qr) => {

    console.log("QR généré")
    qrcodeTerminal.generate(qr, {small:true})

    const dataUrl = await QRCode.toDataURL(qr)
    const base64 = dataUrl.replace(/^data:image\/png;base64,/,"")
    const buffer = Buffer.from(base64,'base64')

    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID)

    await channel.send({
        content:"Scanner ce QR pour connecter WhatsApp",
        files:[{attachment:buffer,name:"whatsapp_qr.png"}]
    })

})

// ================= READY =================
whatsappClient.on("ready", () => {
    console.log("WhatsApp prêt")
})

discordClient.once("ready", () => {
    console.log("Discord prêt")
})

// ================= SAUVEGARDE MEDIA =================
function saveMedia(buffer,ext){

    const name = Date.now()+"."+ext
    const file = path.join(MEDIA_DIR,name)

    fs.writeFileSync(file,buffer)

    return file
}

// ================= WHATSAPP → DISCORD =================
whatsappClient.on("message", async msg => {

    if (!selectedGroupId) return
    if (msg.from !== selectedGroupId) return

    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID)

    const contact = await msg.getContact()
    const pseudo = contact.pushname || contact.name || contact.number

    try{

        let reference = null

        if (msg.hasQuotedMsg){

            const quoted = await msg.getQuotedMessage()

            for (const [discordId,waId] of messageMap.entries()){
                if (waId === quoted.id._serialized){
                    reference = discordId
                    break
                }
            }

        }

        // ===== TEXTE =====
        if (msg.body && !msg.hasMedia){

            const sent = await channel.send({
                content:`${pseudo} : ${msg.body}`,
                reply: reference ? {messageReference:reference} : undefined
            })

            messageMap.set(sent.id,msg.id._serialized)

        }

        // ===== MEDIA =====
        if (msg.hasMedia){

            const media = await msg.downloadMedia()
            if (!media) return

            const buffer = Buffer.from(media.data,'base64')

            let ext="dat"

            if (msg.type==="image") ext="png"
            if (msg.type==="video") ext="mp4"
            if (msg.type==="audio"||msg.type==="ptt") ext="ogg"
            if (msg.type==="sticker") ext="webp"

            const file = saveMedia(buffer,ext)

            const sent = await channel.send({
                content:`${pseudo} : [${msg.type}]`,
                files:[file]
            })

            messageMap.set(sent.id,msg.id._serialized)

        }

    }catch(err){
        console.error("Erreur WA → Discord",err)
    }

})

// ================= DISCORD → WHATSAPP =================
discordClient.on("messageCreate", async message => {

    if (message.author.bot) return
    if (!selectedGroupId) return

    const displayName = message.member?.displayName || message.author.username

    try{

        let quoted=null

        if (message.reference?.messageId){

            const waId = messageMap.get(message.reference.messageId)
            if (waId) quoted = waId

        }

        // ===== TEXTE =====
        if (message.content){

            const sent = await whatsappClient.sendMessage(
                selectedGroupId,
                `${displayName} : ${message.content}`,
                quoted ? {quotedMessageId:quoted} : {}
            )

            messageMap.set(message.id,sent.id._serialized)

        }

        // ===== MEDIA =====
        for (const att of message.attachments.values()){

            const media = await MessageMedia.fromUrl(att.url)

            const sent = await whatsappClient.sendMessage(
                selectedGroupId,
                media,
                {
                    caption:`${displayName} : [media]`,
                    quotedMessageId:quoted || undefined
                }
            )

            messageMap.set(message.id,sent.id._serialized)

        }

    }catch(err){
        console.error("Erreur Discord → WhatsApp",err)
    }

})

// ================= COMMANDES =================
discordClient.on("messageCreate", async message => {

    if (message.author.bot) return

    const content = message.content.trim()

    if (content === "!groupes"){

        const chats = await whatsappClient.getChats()
        const groups = chats.filter(c=>c.isGroup)

        if (!groups.length)
            return message.reply("Aucun groupe trouvé")

        let txt="Groupes WhatsApp :\n"

        groups.forEach((g,i)=>{
            txt+=`${i+1}. ${g.name}\n`
        })

        message.reply(txt)

    }

    if (content.startsWith("!select ")){

        const num=parseInt(content.split(" ")[1])-1

        const chats = await whatsappClient.getChats()
        const groups = chats.filter(c=>c.isGroup)

        if (!groups[num])
            return message.reply("Numéro invalide")

        selectedGroupId = groups[num].id._serialized

        message.reply("Groupe sélectionné : "+groups[num].name)

    }

})

// ================= START =================
discordClient.login(DISCORD_TOKEN)
whatsappClient.initialize()