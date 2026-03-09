// ================= IMPORTS =================
const fs = require("fs")
const path = require("path")
const { Client: DiscordClient, GatewayIntentBits } = require("discord.js")
const { Client: WhatsAppClient, LocalAuth, MessageMedia } = require("whatsapp-web.js")
const QRCode = require("qrcode")

// ================= CONFIG =================
const DISCORD_TOKEN = "TOKEN_DISCORD"
const DISCORD_CHANNEL_ID = "CHANNEL_ID"

const MEDIA_DIR = "./media"
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR)

let selectedGroupId = null
const messageMap = new Map()

// ================= DISCORD =================
const discordClient = new DiscordClient({
    intents:[
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
})

// ================= WHATSAPP =================
const whatsappClient = new WhatsAppClient({
    authStrategy:new LocalAuth(),
    puppeteer:{
        headless:true,
        args:["--no-sandbox","--disable-setuid-sandbox"]
    }
})

// ================= QR CODE =================
whatsappClient.on("qr", async qr => {

    const dataUrl = await QRCode.toDataURL(qr)
    const base64 = dataUrl.replace(/^data:image\/png;base64,/,"")
    const buffer = Buffer.from(base64,"base64")

    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID)

    await channel.send({
        content:"Scanner ce QR pour connecter WhatsApp",
        files:[{attachment:buffer,name:"whatsapp_qr.png"}]
    })

})

// ================= READY =================
whatsappClient.on("ready",()=>console.log("WhatsApp prêt"))
discordClient.once("ready",()=>console.log("Discord prêt"))

// ================= SAVE MEDIA =================
function saveMedia(buffer,ext){

    const name = Date.now()+"."+ext
    const file = path.join(MEDIA_DIR,name)

    fs.writeFileSync(file,buffer)

    return file
}

// ================= WHATSAPP → DISCORD =================
whatsappClient.on("message", async msg=>{

    if(!selectedGroupId) return
    if(msg.from!==selectedGroupId) return

    const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID)

    const contact = await msg.getContact()
    const pseudo = contact.pushname || contact.name || contact.number

    try{

        if(msg.body && !msg.hasMedia){

            const sent = await channel.send(`${pseudo} : ${msg.body}`)

            messageMap.set(sent.id,msg.id._serialized)

        }

        if(msg.hasMedia){

            const media = await msg.downloadMedia()
            if(!media) return

            const buffer = Buffer.from(media.data,"base64")

            let ext="dat"

            if(msg.type==="image") ext="png"
            if(msg.type==="video") ext="mp4"
            if(msg.type==="audio"||msg.type==="ptt") ext="ogg"
            if(msg.type==="sticker") ext="webp"

            const file = saveMedia(buffer,ext)

            const sent = await channel.send({
                content:`${pseudo} : [${msg.type}]`,
                files:[file]
            })

            messageMap.set(sent.id,msg.id._serialized)

        }

    }catch(err){
        console.log(err)
    }

})

// ================= DISCORD → WHATSAPP =================
discordClient.on("messageCreate", async message=>{

    if(message.author.bot) return
    if(!selectedGroupId) return

    const displayName = message.member?.displayName || message.author.username

    try{

        if(message.content){

            const sent = await whatsappClient.sendMessage(
                selectedGroupId,
                `${displayName} : ${message.content}`
            )

            messageMap.set(message.id,sent.id._serialized)

        }

        for(const att of message.attachments.values()){

            const media = await MessageMedia.fromUrl(att.url)

            const sent = await whatsappClient.sendMessage(
                selectedGroupId,
                media,
                {caption:`${displayName} : [media]`}
            )

            messageMap.set(message.id,sent.id._serialized)

        }

    }catch(err){
        console.log(err)
    }

})

// ================= SUPPRESSION =================
discordClient.on("messageDelete", async message=>{

    const waId = messageMap.get(message.id)
    if(!waId) return

    try{

        const chat = await whatsappClient.getChatById(selectedGroupId)
        const msgs = await chat.fetchMessages({limit:50})

        const target = msgs.find(m=>m.id._serialized===waId)

        if(target) await target.delete(true)

    }catch(err){}

})

// ================= WA DELETE =================
whatsappClient.on("message_revoke_everyone", async msg=>{

    for(const [discordId,waId] of messageMap.entries()){

        if(waId===msg.id._serialized){

            const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID)

            try{

                const m = await channel.messages.fetch(discordId)
                m.delete()

            }catch(e){}

        }

    }

})

// ================= MODIFICATION =================
discordClient.on("messageUpdate", async(oldMsg,newMsg)=>{

    if(newMsg.author.bot) return
    if(!selectedGroupId) return

    const displayName = newMsg.member?.displayName || newMsg.author.username

    await whatsappClient.sendMessage(
        selectedGroupId,
        `✏️ Message modifié :\n${displayName} : ${newMsg.content}`
    )

})

// ================= PIN DISCORD =================
discordClient.on("channelPinsUpdate", async channel=>{

    if(channel.id!==DISCORD_CHANNEL_ID) return

    const pins = await channel.messages.fetchPinned()
    const last = pins.first()

    if(!last) return

    const displayName = last.member?.displayName || last.author.username

    await whatsappClient.sendMessage(
        selectedGroupId,
        `📌 Message épinglé :\n${displayName} : ${last.content}`
    )

})

// ================= COMMANDES =================
discordClient.on("messageCreate", async message=>{

    if(message.author.bot) return

    const content = message.content.trim()

    if(content==="!groupes"){

        const chats = await whatsappClient.getChats()
        const groups = chats.filter(c=>c.isGroup)

        let txt="Groupes WhatsApp :\n"

        groups.forEach((g,i)=>{
            txt+=`${i+1}. ${g.name}\n`
        })

        message.reply(txt)

    }

    if(content.startsWith("!select ")){

        const num=parseInt(content.split(" ")[1])-1

        const chats = await whatsappClient.getChats()
        const groups = chats.filter(c=>c.isGroup)

        if(!groups[num])
            return message.reply("Numéro invalide")

        selectedGroupId = groups[num].id._serialized

        message.reply("Groupe sélectionné : "+groups[num].name)

    }

})

// ================= START =================
discordClient.login(DISCORD_TOKEN)
whatsappClient.initialize()