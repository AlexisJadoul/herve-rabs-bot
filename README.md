# Hervé_RABS Bot Discord

Bot Discord connecté à OpenRouter avec :

- réponses quand le bot est mentionné
- réponses spontanées parfois
- relances après silence entre 10 et 30 minutes
- commandes pour ajouter du contexte
- commandes pour ajouter des blagues/private jokes
- humeurs réglables

## 1. Préparation Discord

Dans le Discord Developer Portal :

1. Ouvre ton application de bot
2. Va dans l'onglet `Bot`
3. Active `Message Content Intent`
4. Copie ton token avec `Reset Token`

## 2. Installation

```bash
npm install
```

## 3. Configuration

Copie `.env.example` en `.env` puis remplis :

```env
DISCORD_TOKEN=ton_token_discord
OPENROUTER_API_KEY=ta_cle_openrouter
```

## 4. Lancement

```bash
npm start
```

## 5. Commandes Discord

```text
!context ajouter Dans le service, on dit souvent que c'est surement le cache.
!context liste
!context supprimer 1

!blague ajouter C'est le matin les coco, motivation en telechargement bas debit.
!blague liste
!blague supprimer 1

!humeur collegue
!humeur fatigue
!humeur corporate
!humeur calme
!humeur beaufgentil
!humeur-actuelle
!aide-herve
```

## 6. Notes

Le bot lit les messages uniquement si `Message Content Intent` est activé.
Le token Discord ne doit jamais être partagé.
