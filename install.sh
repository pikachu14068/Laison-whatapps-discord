#!/bin/bash
# ==============================================================================
# Script d'installation automatique pour Ubuntu / Debian
# Ce fichier doit être exécuté UNE SEULE FOIS lors de la première installation.
# ==============================================================================

set -e

echo "=== Début de l'installation du Bridge WhatsApp - Discord (Ubuntu/Debian) ==="

# 1. Mise à jour du système et dépendances de base
echo "[1/5] Mise à jour des paquets système..."
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget gnupg ca-certificates apt-transport-https git

# 2. Installation de Node.js 20 LTS
echo "[2/5] Installation de Node.js (v20 LTS)..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
else
    echo "Node.js v20+ est déjà installé ($(node -v))."
fi

# 3. Installation de PM2
echo "[3/5] Installation globale de PM2..."
sudo npm install -g pm2
pm2 startup | tail -n 1 > /tmp/pm2_cmd.sh || true
if [ -s /tmp/pm2_cmd.sh ]; then
    bash /tmp/pm2_cmd.sh || true
    rm -f /tmp/pm2_cmd.sh
fi

# 4. Initialisation du projet et dépendances NPM
echo "[4/5] Installation des packages Node.js du projet..."
if [ ! -f "package.json" ]; then
    npm init -y
fi

npm install discord.js dotenv @whiskeysockets/baileys node-cache qrcode node-fetch@2 form-data pino @hapi/boom

# 5. Structure dossiers et fichier .env
echo "[5/5] Création de la structure de fichiers..."
mkdir -p media wa_auth

if [ ! -f ".env" ]; then
    cat << 'EOF' > .env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DISCORD_CHANNEL_ID=
WEBHOOK_URL=
GROQ_API_KEY=
EOF
    echo "Le fichier .env a été généré."
fi

echo ""
echo "======================================================="
echo "  INSTALLATION TERMINÉE AVEC SUCCÈS (Ubuntu / Debian)  "
echo "======================================================="
echo "Prochaines étapes :"
echo "1. Editez le fichier .env : nano .env"
echo "2. Lancez le bot : pm2 start bot.js --name bot-whatsapp"
echo "3. Enregistrez le démarrage : pm2 save"
