# 🌉 Bridge WhatsApp ↔ Discord

Ce projet permet de relier un groupe/salon WhatsApp avec un salon Discord de façon transparente avec gestion du multimédia, transcription vocale (Groq) et synchronisation bi-directionnelle.

---

## 📋 Prérequis et Fichiers d'installation fournis

Le projet comprend deux scripts d'installation automatique **à exécuter une seule fois** selon votre système d'exploitation :

* **`install.sh`** : Pour les serveurs Linux (**Ubuntu** et **Debian**).
* **`install-windows.bat`** : Pour les ordinateurs sous **Windows**.

---

## 🚀 Guide d'installation rapide

### Option A : Sur Linux (Ubuntu / Debian)

1. Ouvrez votre terminal ou connectez-vous en SSH à votre VPS :
   ```bash
   cd /chemin/vers/votre/projet
   ```

2. Autorisez et lancez le script d'installation (à faire 1 seule fois) :
   ```bash
   chmod +x install.sh
   ./install.sh
   ```

3. Éditez votre fichier `.env` :
   ```bash
   nano .env
   ```

4. Lancez le bot :
   ```bash
   pm2 start bot.js --name bot-whatsapp
   pm2 save
   ```

5. Affichez les logs pour scanner le QR Code WhatsApp :
   ```bash
   pm2 logs bot-whatsapp
   ```

---

### Option B : Sur Windows

1. Téléchargez et installez **Node.js LTS (v20+)** depuis le site officiel : [https://nodejs.org/](https://nodejs.org/) si ce n'est pas déjà fait.
2. Ouvrez le dossier du projet.
3. Double-cliquez sur le fichier **`install-windows.bat`** (ou lancez-le dans une invite de commande `cmd`).
4. Une fois l'installation terminée, ouvrez le fichier `.env` avec le Bloc-notes pour le compléter.
5. Ouvrez une invite de commande dans ce dossier et lancez le bot :
   ```cmd
   pm2 start bot.js --name bot-whatsapp
   ```
6. Affichez les logs pour scanner le QR Code :
   ```cmd
   pm2 logs bot-whatsapp
   ```

---

## ⚙️ Configuration du fichier `.env`

Remplissez le fichier `.env` généré automatiquement par le script avec vos propres clés :

```env
DISCORD_TOKEN=OTk...          # Jeton (Token) de votre Bot Discord
DISCORD_CLIENT_ID=123...      # ID de l'application Discord
DISCORD_GUILD_ID=123...       # ID de votre serveur Discord
DISCORD_CHANNEL_ID=123...     # ID du salon Discord cible
WEBHOOK_URL=https://...       # URL Webhook du salon Discord
GROQ_API_KEY=gsk_...          # Clé API Groq (Optionnel - pour les vocaux)
```

---

## ⚙️ Création du Bot Discord (Rappel)

1. Allez sur le **[Discord Developer Portal](https://discord.com/developers/applications)**.
2. Cliquez sur **New Application**, entrez un nom et validez.
3. Dans la section **Bot** :
   - Récupérez le token (**Reset Token**).
   - Activez les **Privileged Gateway Intents** :
     - *Message Content Intent*
     - *Server Members Intent*
     - *Presence Intent*
4. Dans **OAuth2** > **URL Generator** :
   - Sélectionnez `bot` et `applications.commands`.
   - Permissions : *Read Messages*, *Send Messages*, *Manage Messages*, *Read Message History*.
   - Copiez le lien généré pour inviter le bot sur votre serveur.
