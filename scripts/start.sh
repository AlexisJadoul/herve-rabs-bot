#!/bin/bash

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="discord-collegues-bot"

cd "$PROJECT_DIR"

if [ ! -f ".env" ]; then
    echo "Erreur : fichier .env introuvable."
    echo "Crée ton fichier .env avant de démarrer le bot."
    exit 1
fi

if [ ! -d "venv" ]; then
    echo "Erreur : environnement Python venv introuvable."
    echo "Lance d'abord : bash scripts/install.sh"
    exit 1
fi

echo "Démarrage du bot..."
sudo systemctl restart "$SERVICE_NAME"

echo ""
echo "Statut du service :"
sudo systemctl --no-pager status "$SERVICE_NAME"