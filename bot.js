const { Client, GatewayIntentBits } = require("discord.js")
const { Client: WAClient, LocalAuth, MessageMedia } = require("whatsapp-web.js")
const qrcode = require("qrcode")
const fs = require("fs")
const path = require("path")

const DISCORD_TOKEN = "TOKEN_DISCORD"
const DISCORD_CHANNEL_ID = "CHANNEL_ID"

let selectedGroupId = null
let whatsappReady = false

const messageMap = new Map()

const mediaFolder = "./media"

if(!fs.existsSync(mediaFolder)){
fs.mkdirSync(mediaFolder)
}

const discordClient = new Client({
intents:[
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent
]
})

const whatsappClient = new WAClient({
authStrategy:new LocalAuth(),
puppeteer:{
args:["--no-sandbox","--disable-setuid-sandbox"]
}
})

/* ================= DISCORD READY ================= */

discordClient.once("clientReady",()=>{
console.log("Discord connecté")
})

/* ================= WHATSAPP QR ================= */

whatsappClient.on("qr", async qr => {

const qrImage = await qrcode.toDataURL(qr)

const base64 = qrImage.split(",")[1]
const buffer = Buffer.from(base64,"base64")

fs.writeFileSync("qr.png",buffer)

const channel = await discordClient.channels.fetch(DISCORD_CHANNEL_ID)

channel.send({
content:"Voici le QR code WhatsApp",
files:["qr.png"]
})

})

/* ================= WHATSAPP READY ================= */

whatsappClient.on("ready",()=>{
console.log("WhatsApp prêt")
whatsappReady = true
})

/* ================= COMMANDES DISCORD ================= */

discordClient.on("messageCreate", async message => {

if(message.author.bot) return
if(message.channel.id !== DISCORD_CHANNEL_ID) return

/* GROUPES */

if(message.content === "!groupes"){

if(!whatsappReady){
return message.reply("WhatsApp pas encore prêt")
}

const chats = await whatsappClient.getChats()
const groups = chats.filter(c=>c.isGroup)

let txt="Groupes WhatsApp :\n"

groups.forEach((g,i)=>{
txt+=`${i} - ${g.name}\n`
})

message.channel.send(txt)
}

/* SELECT */

if(message.content.startsWith("!select")){

const index=parseInt(message.content.split(" ")[1])

const chats=await whatsappClient.getChats()
const groups=chats.filter(c=>c.isGroup)

if(!groups[index]){
return message.reply("Index invalide")
}

selectedGroupId=groups[index].id._serialized

message.channel.send("Groupe sélectionné : "+groups[index].name)
}

/* DISCORD → WHATSAPP */

if(!selectedGroupId) return
if(message.content.startsWith("!")) return

const displayName =
message.member?.displayName || message.author.username

let options={}

/* REPLY */

if(message.reference){

try{

const replied =
await message.channel.messages.fetch(message.reference.messageId)

const waQuotedId=messageMap.get(replied.id)

if(waQuotedId){
options.quotedMessageId=waQuotedId
}

}catch{}
}

/* TEXTE */

if(message.content){

const sent=await whatsappClient.sendMessage(
selectedGroupId,
`${displayName} : ${message.content}`,
options
)

messageMap.set(message.id,sent.id._serialized)

}

/* FICHIERS DISCORD → WHATSAPP */

if(message.attachments.size>0){

for(const attachment of message.attachments.values()){

const media=await MessageMedia.fromUrl(attachment.url)

await whatsappClient.sendMessage(
selectedGroupId,
media,
{caption:displayName}
)

}

}

})

/* ================= WHATSAPP → DISCORD ================= */

whatsappClient.on("message", async msg => {

if(!selectedGroupId) return
if(msg.from!==selectedGroupId) return
if(msg.fromMe) return

const contact=await msg.getContact()
const name=contact.pushname||contact.number

const channel=await discordClient.channels.fetch(DISCORD_CHANNEL_ID)

let replyOptions={}

/* REPLY */

if(msg.hasQuotedMsg){

const quoted=await msg.getQuotedMessage()

for(const [discordId,waId] of messageMap.entries()){

if(waId===quoted.id._serialized){

replyOptions.messageReference=discordId
break

}

}

}

const sent=await channel.send({
content:`**${name} :** ${msg.body}`,
...replyOptions
})

messageMap.set(sent.id,msg.id._serialized)

/* MEDIA */

if(msg.hasMedia){

const media=await msg.downloadMedia()

let ext="png"

if(media.mimetype.includes("video")) ext="mp4"
if(media.mimetype.includes("audio")) ext="ogg"

const filename=Date.now()+"."+ext

const filepath=path.join(mediaFolder,filename)

fs.writeFileSync(filepath,media.data,"base64")

channel.send({
files:[filepath]
})

}

})

/* ================= SUPPRESSION SYNC ================= */

discordClient.on("messageDelete", async message => {

const waId=messageMap.get(message.id)

if(!waId) return

try{

const chat=await whatsappClient.getChatById(selectedGroupId)

const msgs=await chat.fetchMessages({limit:50})

const target=msgs.find(m=>m.id._serialized===waId)

if(target){
await target.delete(true)
}

}catch{}

})

/* ================= START ================= */

discordClient.login(DISCORD_TOKEN)
whatsappClient.initialize()