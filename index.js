require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField
} = require("discord.js");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "mistralai/mistral-7b-instruct:free";

let humeur = process.env.BOT_HUMEUR || "collegue";

const SPONTANEOUS_CHANCE = Number(process.env.SPONTANEOUS_CHANCE || 8);
const IDLE_MIN_MINUTES = Number(process.env.IDLE_MIN_MINUTES || 10);
const IDLE_MAX_MINUTES = Number(process.env.IDLE_MAX_MINUTES || 30);
const BOT_COOLDOWN_MINUTES = Number(process.env.BOT_COOLDOWN_MINUTES || 5);
const BOT_COOLDOWN_MS = BOT_COOLDOWN_MINUTES * 60 * 1000;

const ALLOWED_CHANNEL_IDS = (process.env.ALLOWED_CHANNEL_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const BOT_ADMIN_IDS = (process.env.BOT_ADMIN_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const MEMORY_FILE = path.join(__dirname, "memory.json");

if (!DISCORD_TOKEN) {
  console.error("Erreur : DISCORD_TOKEN est manquant dans le fichier .env");
  process.exit(1);
}

if (!OPENROUTER_API_KEY) {
  console.error("Erreur : OPENROUTER_API_KEY est manquant dans le fichier .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const salonsSuivis = new Map();

const humeurs = {
  collegue: `
Tu es Hervé_RABS, un bot Discord qui parle comme un collègue sympa et un peu bête.
Tu fais des remarques légères de service, de café, de matin difficile, de réunion et de motivation.
Tu peux dire parfois "les coco", "la team", "les artistes", mais pas à chaque phrase.
Tu réponds en français.
Tu fais court : maximum 2 phrases.
Tu ne dois jamais être méchant, humiliant, agressif ou ciblé contre une personne.
`,

  fatigue: `
Tu es Hervé_RABS, un bot Discord fatigué mais drôle.
Tu réponds comme quelqu'un qui a besoin d'un café avant de comprendre la journée.
Tu réponds en français.
Maximum 2 phrases.
Humour léger, jamais méchant.
`,

  corporate: `
Tu es Hervé_RABS, un bot Discord qui parle comme un collègue beaucoup trop corporate.
Tu transformes les situations simples en phrases de réunion absurdes.
Tu réponds en français.
Maximum 2 phrases.
Humour de bureau, absurde, mais gentil.
`,

  calme: `
Tu es Hervé_RABS, un bot Discord discret et sympa.
Tu réponds peu, calmement, avec une petite touche drôle.
Tu réponds en français.
Maximum 2 phrases.
`,

  beaufgentil: `
Tu es Hervé_RABS, un bot Discord avec un humour de collègue un peu beauf mais toujours gentil.
Tu fais des blagues simples sur le café, le lundi, le matin, les réunions, les bugs, la motivation.
Tu ne fais jamais de blague méchante, sexuelle, discriminante ou ciblée contre quelqu'un.
Tu réponds en français.
Maximum 2 phrases.
`
};

const sujetsInterdits = [
  "rh",
  "paie",
  "salaire",
  "maladie",
  "arrêt",
  "arret",
  "absence",
  "licenciement",
  "harcèlement",
  "harcelement",
  "dépression",
  "depression",
  "suicide",
  "plainte",
  "politique",
  "religion",
  "grossesse",
  "divorce",
  "décès",
  "deces",
  "mort",
  "hôpital",
  "hopital"
];

const motsDeclencheurs = [
  "bonjour",
  "salut",
  "coucou",
  "café",
  "cafe",
  "matin",
  "réunion",
  "reunion",
  "bug",
  "travail",
  "bosser",
  "vendredi",
  "lundi",
  "fatigue",
  "planning",
  "urgent",
  "motivation",
  "pause",
  "service",
  "journée",
  "journee"
];

function chargerMemoire() {
  if (!fs.existsSync(MEMORY_FILE)) {
    fs.writeFileSync(
      MEMORY_FILE,
      JSON.stringify({ contextes: [], blagues: [] }, null, 2),
      "utf8"
    );
  }

  try {
    const data = fs.readFileSync(MEMORY_FILE, "utf8");
    const parsed = JSON.parse(data);

    if (!Array.isArray(parsed.contextes)) parsed.contextes = [];
    if (!Array.isArray(parsed.blagues)) parsed.blagues = [];

    return parsed;
  } catch (error) {
    console.error("Erreur lecture memory.json :", error);
    return { contextes: [], blagues: [] };
  }
}

function sauvegarderMemoire(memoire) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memoire, null, 2), "utf8");
}

function nettoyerTexteCommande(texte) {
  return texte.replace(/\s+/g, " ").trim();
}

function getMemoireTexte() {
  const memoire = chargerMemoire();

  const contextes = memoire.contextes.length
    ? memoire.contextes.map((c, i) => `${i + 1}. ${c}`).join("\n")
    : "Aucun contexte ajouté.";

  const blagues = memoire.blagues.length
    ? memoire.blagues.map((b, i) => `${i + 1}. ${b}`).join("\n")
    : "Aucune blague ajoutée.";

  return `
Contextes connus :
${contextes}

Blagues et private jokes disponibles :
${blagues}
`;
}

function getBlagueAleatoire() {
  const memoire = chargerMemoire();
  if (!memoire.blagues.length) return null;

  const index = Math.floor(Math.random() * memoire.blagues.length);
  return memoire.blagues[index];
}

function randomEntre(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function prochainSilenceMs() {
  const minutes = randomEntre(IDLE_MIN_MINUTES, IDLE_MAX_MINUTES);
  return minutes * 60 * 1000;
}

function contientSujetInterdit(texte) {
  const min = texte.toLowerCase();
  return sujetsInterdits.some((mot) => min.includes(mot));
}

function contientMotDeclencheur(texte) {
  const min = texte.toLowerCase();
  return motsDeclencheurs.some((mot) => min.includes(mot));
}

function salonAutorise(message) {
  if (!ALLOWED_CHANNEL_IDS.length) return true;
  return ALLOWED_CHANNEL_IDS.includes(message.channel.id);
}

function estAdminBot(message) {
  if (BOT_ADMIN_IDS.includes(message.author.id)) return true;
  if (!message.member) return false;

  return message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    || message.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

function peutEnvoyer(channel) {
  return channel && typeof channel.send === "function";
}

async function appelerOpenRouter(messages, maxTokens = 140, temperature = 0.9) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://discord.com",
      "X-Title": "Herve RABS Discord Bot"
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature
    })
  });

  if (!response.ok) {
    const erreur = await response.text();
    console.error("Erreur OpenRouter :", erreur);
    throw new Error("Erreur OpenRouter");
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function genererReponseIA(messageUtilisateur, contexte = "message Discord") {
  const promptSysteme = `
${humeurs[humeur] || humeurs.collegue}

Mémoire ajoutée par les utilisateurs :
${getMemoireTexte()}

Règles importantes :
- Tu peux utiliser les contextes et blagues parfois, mais pas tout le temps.
- Tu peux t'inspirer des blagues sans forcément les recopier mot pour mot.
- Tu dois rester naturel, court et drôle.
- Tu réponds en français.
- Tu ne fais jamais de remarque blessante ou personnelle.
- Tu évites les sujets sensibles.
- Maximum 2 phrases.
`;

  const reponse = await appelerOpenRouter([
    {
      role: "system",
      content: promptSysteme
    },
    {
      role: "user",
      content: `
Contexte : ${contexte}

Message Discord :
"${messageUtilisateur}"

Réponds comme Hervé_RABS.
`
    }
  ]);

  return reponse || "J'avais une vanne, mais elle est partie en pause café.";
}

async function doitIntervenirIA(messageUtilisateur) {
  const prompt = `
Tu es le filtre d'un bot Discord humoristique.

Tu dois répondre uniquement par OUI ou NON.

Réponds OUI seulement si une petite intervention drôle, courte et gentille est pertinente.
Réponds NON si le message est sérieux, personnel, sensible, administratif important, ou si le bot risque d'être lourd.

Message :
"${messageUtilisateur}"
`;

  const reponse = await appelerOpenRouter([
    {
      role: "system",
      content: "Tu réponds uniquement par OUI ou NON."
    },
    {
      role: "user",
      content: prompt
    }
  ], 10, 0.2);

  return reponse.toUpperCase().includes("OUI");
}

async function gererCommandeContext(message, texte) {
  if (!estAdminBot(message)) {
    return message.reply("Seuls les admins peuvent modifier mon contexte, petit malin.");
  }

  const args = texte.split(" ");
  const action = args[1];
  const contenu = nettoyerTexteCommande(args.slice(2).join(" "));

  const memoire = chargerMemoire();

  if (action === "ajouter") {
    if (!contenu) {
      return message.reply("Exemple : `!context ajouter Dans le service, on dit souvent que c'est surement le cache.`");
    }

    memoire.contextes.push(contenu);
    sauvegarderMemoire(memoire);

    return message.reply("Contexte ajouté. Je vais faire semblant de m'en souvenir intelligemment.");
  }

  if (action === "liste") {
    if (!memoire.contextes.length) {
      return message.reply("Aucun contexte enregistré pour le moment.");
    }

    const liste = memoire.contextes
      .map((c, i) => `${i + 1}. ${c}`)
      .join("\n");

    return message.reply(`Contextes enregistrés :\n${liste}`);
  }

  if (action === "supprimer") {
    const index = parseInt(args[2], 10) - 1;

    if (Number.isNaN(index) || !memoire.contextes[index]) {
      return message.reply("Numéro invalide. Exemple : `!context supprimer 2`");
    }

    const supprime = memoire.contextes.splice(index, 1);
    sauvegarderMemoire(memoire);

    return message.reply(`Contexte supprimé : ${supprime[0]}`);
  }

  return message.reply("Commandes : `!context ajouter`, `!context liste`, `!context supprimer`");
}

async function gererCommandeBlague(message, texte) {
  if (!estAdminBot(message)) {
    return message.reply("Seuls les admins peuvent m'ajouter des blagues, sinon ça va finir en open bar.");
  }

  const args = texte.split(" ");
  const action = args[1];
  const contenu = nettoyerTexteCommande(args.slice(2).join(" "));

  const memoire = chargerMemoire();

  if (action === "ajouter") {
    if (!contenu) {
      return message.reply("Exemple : `!blague ajouter C'est le matin les coco, motivation en téléchargement bas débit.`");
    }

    memoire.blagues.push(contenu);
    sauvegarderMemoire(memoire);

    return message.reply("Blague ajoutée. Je vais peut-être la ressortir au pire moment.");
  }

  if (action === "liste") {
    if (!memoire.blagues.length) {
      return message.reply("Aucune blague enregistrée pour le moment.");
    }

    const liste = memoire.blagues
      .map((b, i) => `${i + 1}. ${b}`)
      .join("\n");

    return message.reply(`Blagues enregistrées :\n${liste}`);
  }

  if (action === "supprimer") {
    const index = parseInt(args[2], 10) - 1;

    if (Number.isNaN(index) || !memoire.blagues[index]) {
      return message.reply("Numéro invalide. Exemple : `!blague supprimer 1`");
    }

    const supprime = memoire.blagues.splice(index, 1);
    sauvegarderMemoire(memoire);

    return message.reply(`Blague supprimée : ${supprime[0]}`);
  }

  return message.reply("Commandes : `!blague ajouter`, `!blague liste`, `!blague supprimer`");
}

async function gererCommandeHumeur(message, texte) {
  if (!estAdminBot(message)) {
    return message.reply("Seuls les admins peuvent changer mon humeur. Déjà que je suis instable.");
  }

  const args = texte.split(" ");
  const nouvelleHumeur = args[1];

  if (!nouvelleHumeur || !humeurs[nouvelleHumeur]) {
    return message.reply(`Humeurs disponibles : ${Object.keys(humeurs).join(", ")}`);
  }

  humeur = nouvelleHumeur;

  return message.reply(`Ok les coco, humeur changée : ${humeur}`);
}

function enregistrerActiviteHumaine(message) {
  const maintenant = Date.now();
  const ancienEtat = salonsSuivis.get(message.channel.id);

  salonsSuivis.set(message.channel.id, {
    channel: message.channel,
    lastHumanMessageAt: maintenant,
    lastBotMessageAt: ancienEtat?.lastBotMessageAt || 0,
    nextIdleAt: maintenant + prochainSilenceMs()
  });
}

async function gererRelancesSilence() {
  const maintenant = Date.now();

  for (const [channelId, etat] of salonsSuivis.entries()) {
    const channel = etat.channel;

    if (!peutEnvoyer(channel)) continue;
    if (ALLOWED_CHANNEL_IDS.length && !ALLOWED_CHANNEL_IDS.includes(channelId)) continue;

    const silenceAtteint = maintenant >= etat.nextIdleAt;
    const cooldownOk = maintenant - etat.lastBotMessageAt >= BOT_COOLDOWN_MS;

    if (!silenceAtteint || !cooldownOk) continue;

    try {
      let messageRelance;
      const blague = getBlagueAleatoire();

      if (blague && Math.random() < 0.5) {
        messageRelance = blague;
      } else {
        messageRelance = await genererReponseIA(
          "Personne ne parle depuis un moment. Lance une petite phrase drôle pour relancer la conversation dans le service.",
          "relance automatique après silence"
        );
      }

      await channel.send(messageRelance);

      salonsSuivis.set(channelId, {
        ...etat,
        lastBotMessageAt: maintenant,
        nextIdleAt: maintenant + prochainSilenceMs()
      });
    } catch (error) {
      console.error("Erreur relance silence :", error);
    }
  }
}

client.once("ready", () => {
  console.log(`Bot connecté : ${client.user.tag}`);
  console.log(`Humeur actuelle : ${humeur}`);
  console.log(`Modèle OpenRouter : ${OPENROUTER_MODEL}`);
  console.log(`Chance spontanée : ${SPONTANEOUS_CHANCE}%`);
  console.log(`Relance silence : entre ${IDLE_MIN_MINUTES} et ${IDLE_MAX_MINUTES} minutes`);

  setInterval(gererRelancesSilence, 60 * 1000);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!salonAutorise(message)) return;

    const texte = message.content || "";
    const texteMin = texte.toLowerCase();

    enregistrerActiviteHumaine(message);

    if (texteMin.startsWith("!context")) {
      return gererCommandeContext(message, texte);
    }

    if (texteMin.startsWith("!blague")) {
      return gererCommandeBlague(message, texte);
    }

    if (texteMin.startsWith("!humeur")) {
      return gererCommandeHumeur(message, texte);
    }

    if (texteMin === "!humeur-actuelle") {
      return message.reply(`Humeur actuelle : ${humeur}`);
    }

    if (texteMin === "!aide-herve") {
      return message.reply(`
Commandes disponibles :
!context ajouter ...
!context liste
!context supprimer 1

!blague ajouter ...
!blague liste
!blague supprimer 1

!humeur collegue
!humeur fatigue
!humeur corporate
!humeur calme
!humeur beaufgentil
!humeur-actuelle
`);
    }

    if (contientSujetInterdit(texte)) return;

    const estMentionne = message.mentions.has(client.user);

    if (estMentionne) {
      const reponse = await genererReponseIA(
        texte,
        "Le bot a été mentionné directement."
      );

      const etat = salonsSuivis.get(message.channel.id);
      if (etat) {
        etat.lastBotMessageAt = Date.now();
        salonsSuivis.set(message.channel.id, etat);
      }

      return message.reply(reponse);
    }

    const maintenant = Date.now();
    const etat = salonsSuivis.get(message.channel.id);

    if (etat && maintenant - etat.lastBotMessageAt < BOT_COOLDOWN_MS) return;

    const aMotDeclencheur = contientMotDeclencheur(texte);
    const chanceOk = Math.random() < SPONTANEOUS_CHANCE / 100;

    if (!aMotDeclencheur && !chanceOk) return;
    if (!chanceOk) return;

    const interventionOk = await doitIntervenirIA(texte);
    if (!interventionOk) return;

    const reponse = await genererReponseIA(
      texte,
      "Le bot intervient spontanément dans une discussion Discord."
    );

    if (etat) {
      etat.lastBotMessageAt = maintenant;
      salonsSuivis.set(message.channel.id, etat);
    }

    return message.reply(reponse);
  } catch (error) {
    console.error("Erreur messageCreate :", error);
  }
});

client.login(DISCORD_TOKEN);
