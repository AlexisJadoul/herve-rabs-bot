#!/bin/bash

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="discord-collegues-bot"

cd "$PROJECT_DIR"

echo "Mise à jour du bot depuis GitHub..."

if [ ! -d ".git" ]; then
    echo "Erreur : ce dossier n'est pas un dépôt Git."
    exit 1
fi

git pull

if [ ! -d "venv" ]; then
    echo "Environnement Python absent, création..."
    python3 -m venv venv
fi

echo "Mise à jour des dépendances..."
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
deactivate

echo "Redémarrage du service..."
sudo systemctl restart "$SERVICE_NAME"

echo ""
echo "Mise à jour terminée."
echo ""
echo "Statut du service :"
sudo systemctl --no-pager status "$SERVICE_NAME"