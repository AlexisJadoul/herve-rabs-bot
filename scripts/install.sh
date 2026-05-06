#!/bin/bash

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="discord-collegues-bot"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "Installation du bot Discord..."
cd "$PROJECT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
    echo "Installation de Python..."
    sudo apt update
    sudo apt install -y python3 python3-pip python3-venv
fi

if [ ! -f "requirements.txt" ]; then
    echo "Erreur : requirements.txt introuvable."
    exit 1
fi

if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "Fichier .env créé depuis .env.example."
        echo "Modifie le fichier .env avant de lancer le bot."
    else
        echo "Erreur : fichier .env introuvable."
        echo "Crée un fichier .env avec tes tokens Discord et OpenRouter."
        exit 1
    fi
fi

echo "Création de l'environnement Python..."
python3 -m venv venv

echo "Installation des dépendances..."
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
deactivate

echo "Création du service systemd..."

sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Discord Collegues Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$PROJECT_DIR/venv/bin/python $PROJECT_DIR/bot.py
Restart=always
RestartSec=5
User=$USER
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

echo ""
echo "Installation terminée."
echo ""
echo "Avant le premier lancement, vérifie ton fichier .env :"
echo "nano $PROJECT_DIR/.env"
echo ""
echo "Puis lance :"
echo "bash scripts/start.sh"