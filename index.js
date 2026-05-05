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
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";

const WEATHER_CITY = process.env.WEATHER_CITY || "Redon";
const WEATHER_COUNTRY = process.env.WEATHER_COUNTRY || "France";

const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID || "";
const BOT_HUMEUR = process.env.BOT_HUMEUR || "collegue";

const SPONTANEOUS_CHANCE = Number(process.env.SPONTANEOUS_CHANCE || 4);
const BOT_COOLDOWN_MINUTES = Number(process.env.BOT_COOLDOWN_MINUTES || 5);
const IDLE_MIN_MINUTES = Number(process.env.IDLE_MIN_MINUTES || 10);
const IDLE_MAX_MINUTES = Number(process.env.IDLE_MAX_MINUTES || 30);

const BOT_COOLDOWN_MS = BOT_COOLDOWN_MINUTES * 60 * 1000;
const MEMORY_FILE = path.join(__dirname, "bot-memory.json");

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN manquant.");
  process.exit(1);
}

if (!OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY manquant.");
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

const themesDisponibles = [
  "batiment",
  "sous_sol",
  "salles",
  "personnes",
  "prenom_double",
  "meteo",
  "teletravail",
  "reunion",
  "bug",
  "voiture",
  "matin",
  "fin_journee",
  "silence",
  "expression_interne",
  "planning",
  "vendredi",
  "lundi"
];

const motsDeclencheurs = [
  "bonjour",
  "salut",
  "coucou",
  "réunion",
  "reunion",
  "bug",
  "planning",
  "matin",
  "lundi",
  "vendredi",
  "bâtiment",
  "batiment",
  "sous-sol",
  "sous sol",
  "voiture",
  "météo",
  "meteo",
  "travail",
  "service",
  "pause",
  "fatigue"
];

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
  "religion",
  "politique",
  "divorce",
  "décès",
  "deces",
  "handicap",
  "grossesse"
];

function defaultMemory() {
  return {
    admins: [],
    lieu: {
      nom: "Le service",
      ville: WEATHER_CITY,
      description: "",
      details: [],
      salles: []
    },
    personnes: [],
    anecdotes: [],
    expressions: [],
    blagues: [],
    styles: {
      bienvenue: [],
      relance: [],
      matin: [],
      reunion: []
    },
    recent: {
      themes: [],
      responses: []
    }
  };
}

function chargerMemoire() {
  if (!fs.existsSync(MEMORY_FILE)) {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(defaultMemory(), null, 2), "utf8");
  }

  try {
    const data = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    return {
      ...defaultMemory(),
      ...data,
      lieu: { ...defaultMemory().lieu, ...(data.lieu || {}) },
      styles: { ...defaultMemory().styles, ...(data.styles || {}) },
      recent: { ...defaultMemory().recent, ...(data.recent || {}) }
    };
  } catch (error) {
    console.error("Erreur bot-memory.json :", error);
    return defaultMemory();
  }
}

function sauvegarderMemoire(memoire) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memoire, null, 2), "utf8");
}

function nettoyer(texte) {
  return String(texte || "").replace(/\s+/g, " ").trim();
}

function heureLocale() {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    dateStyle: "full",
    timeStyle: "short"
  }).format(new Date());
}

function meteoCode(code) {
  const codes = {
    0: "ciel dégagé",
    1: "plutôt clair",
    2: "partiellement nuageux",
    3: "couvert",
    45: "brouillard",
    48: "brouillard givrant",
    51: "petite bruine",
    53: "bruine",
    55: "forte bruine",
    61: "petite pluie",
    63: "pluie",
    65: "forte pluie",
    71: "neige faible",
    73: "neige",
    75: "forte neige",
    80: "averses faibles",
    81: "averses",
    82: "fortes averses",
    95: "orage"
  };

  return codes[code] || "météo variable";
}

async function getMeteoTexte() {
  try {
    const ville = encodeURIComponent(WEATHER_CITY);
    const pays = encodeURIComponent(WEATHER_COUNTRY);

    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${ville}&count=1&language=fr&format=json`
    );

    const geo = await geoRes.json();
    const result = geo?.results?.[0];

    if (!result) {
      return `Météo indisponible pour ${WEATHER_CITY}.`;
    }

    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${result.latitude}&longitude=${result.longitude}&current=temperature_2m,weather_code&timezone=Europe%2FParis`
    );

    const weather = await weatherRes.json();
    const temp = weather?.current?.temperature_2m;
    const code = weather?.current?.weather_code;

    if (temp === undefined) {
      return `Météo indisponible pour ${WEATHER_CITY}.`;
    }

    return `À ${WEATHER_CITY}, il fait environ ${temp}°C avec ${meteoCode(code)}.`;
  } catch (error) {
    console.error("Erreur météo :", error);
    return `Météo indisponible pour ${WEATHER_CITY}.`;
  }
}

function estSujetInterdit(texte) {
  const min = texte.toLowerCase();
  return sujetsInterdits.some((mot) => min.includes(mot));
}

function contientMotDeclencheur(texte) {
  const min = texte.toLowerCase();
  return motsDeclencheurs.some((mot) => min.includes(mot));
}

function estDiscordAdmin(message) {
  if (!message.member) return false;

  return message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    || message.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

function estAutorise(message) {
  const memoire = chargerMemoire();

  return estDiscordAdmin(message)
    || memoire.admins.includes(message.author.id);
}

function commandeAdminDansBonSalon(message) {
  if (!ADMIN_CHANNEL_ID) return true;
  return message.channel.id === ADMIN_CHANNEL_ID;
}

function choisirTheme() {
  const memoire = chargerMemoire();
  const recents = memoire.recent?.themes || [];

  const possibles = themesDisponibles.filter((theme) => !recents.includes(theme));
  const base = possibles.length ? possibles : themesDisponibles;

  const theme = base[Math.floor(Math.random() * base.length)];

  memoire.recent.themes = [theme, ...recents].slice(0, 6);
  sauvegarderMemoire(memoire);

  return theme;
}

function ajouterReponseRecente(reponse) {
  const memoire = chargerMemoire();

  memoire.recent.responses = [
    nettoyer(reponse),
    ...(memoire.recent.responses || [])
  ].slice(0, 10);

  sauvegarderMemoire(memoire);
}

function getMemoireTexte() {
  const memoire = chargerMemoire();

  const personnes = memoire.personnes.length
    ? memoire.personnes.map((p) => {
      const lignes = [];
      lignes.push(`- ${p.prenom}`);
      if (p.role) lignes.push(`  rôle : ${p.role}`);
      if (p.voiture) lignes.push(`  voiture : ${p.voiture}`);
      if (p.age) lignes.push(`  âge : ${p.age}`);
      if (p.aime?.length) lignes.push(`  aime : ${p.aime.join(", ")}`);
      if (p.habitudes?.length) lignes.push(`  habitudes : ${p.habitudes.join(", ")}`);
      if (p.anecdotes?.length) lignes.push(`  anecdotes : ${p.anecdotes.join(" / ")}`);
      if (p.limites?.length) lignes.push(`  limites : ${p.limites.join(" / ")}`);
      return lignes.join("\n");
    }).join("\n")
    : "Aucune personne enregistrée.";

  const salles = memoire.lieu.salles.length
    ? memoire.lieu.salles.map((s) => `- ${s.nom} : ${s.description || ""} ${s.etage ? `(étage : ${s.etage})` : ""}`).join("\n")
    : "Aucune salle enregistrée.";

  const styles = Object.entries(memoire.styles || {})
    .map(([nom, valeurs]) => {
      if (!valeurs?.length) return null;
      return `${nom} : ${valeurs.join(" / ")}`;
    })
    .filter(Boolean)
    .join("\n") || "Aucun style enregistré.";

  return `
Lieu :
Nom : ${memoire.lieu.nom}
Ville : ${memoire.lieu.ville}
Description : ${memoire.lieu.description || "Non renseignée"}
Détails : ${(memoire.lieu.details || []).join(" / ") || "Aucun détail"}

Salles :
${salles}

Personnes :
${personnes}

Anecdotes générales :
${(memoire.anecdotes || []).join(" / ") || "Aucune anecdote"}

Expressions internes :
${(memoire.expressions || []).join(" / ") || "Aucune expression"}

Blagues déjà données :
${(memoire.blagues || []).join(" / ") || "Aucune blague"}

Styles de messages :
${styles}

Dernières réponses à éviter :
${(memoire.recent.responses || []).join(" / ") || "Aucune"}
`;
}

async function appelerOpenRouter(messages, maxTokens = 180, temperature = 0.85) {
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
    return "J’ai voulu sortir une phrase incroyable, mais mon neurone distant a redémarré.";
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function genererMessageIA({
  instruction,
  contexte = "discussion Discord",
  theme = null,
  mentionPersonne = null,
  style = null,
  inclureMeteo = false
}) {
  const themeChoisi = theme || choisirTheme();
  const meteo = inclureMeteo ? await getMeteoTexte() : "";

  const system = `
Tu es Hervé_RABS, un personnage fictif de serveur Discord.
Tu joues le rôle humoristique d'un collègue développeur en télétravail en Bretagne.
Tu parles naturellement, comme quelqu'un du service.
Tu peux être drôle, taquin, un peu absurde, mais jamais méchant.

Règles importantes :
- Si on te demande directement si tu es un bot, tu dois répondre honnêtement que tu es un personnage/bot du serveur.
- Ne prétends pas être une vraie personne.
- Ne fais pas de blague sur le physique, la santé, la vie privée, l'argent, la religion, la politique, le handicap, l'origine ou les sujets sensibles.
- Ne parle pas toujours de café.
- Varie les thèmes.
- Ne répète pas les dernières réponses.
- Maximum 2 phrases.
- Réponds uniquement avec le message final à envoyer sur Discord.

Humeur actuelle : ${BOT_HUMEUR}
Heure actuelle : ${heureLocale()}
Météo : ${meteo || "Non demandée pour ce message."}
Thème à utiliser cette fois : ${themeChoisi}
Style demandé : ${style || "naturel"}

Mémoire du service :
${getMemoireTexte()}
`;

  const user = `
Contexte : ${contexte}
Personne concernée : ${mentionPersonne || "aucune personne précise"}
Instruction :
${instruction}
`;

  const reponse = await appelerOpenRouter([
    { role: "system", content: system },
    { role: "user", content: user }
  ]);

  ajouterReponseRecente(reponse);

  return reponse;
}

function trouverOuCreerPersonne(memoire, prenom) {
  const normalise = prenom.toLowerCase();

  let personne = memoire.personnes.find((p) => p.prenom.toLowerCase() === normalise);

  if (!personne) {
    personne = {
      prenom,
      role: "",
      voiture: "",
      age: "",
      aime: [],
      habitudes: [],
      anecdotes: [],
      limites: []
    };

    memoire.personnes.push(personne);
  }

  return personne;
}

async function gererDroit(message, texte) {
  if (!estDiscordAdmin(message)) {
    return message.reply("Seuls les admins Discord peuvent gérer les droits.");
  }

  const memoire = chargerMemoire();
  const action = texte.split(" ")[1];
  const user = message.mentions.users.first();

  if (action === "liste") {
    if (!memoire.admins.length) return message.reply("Aucun droit spécifique ajouté.");
    return message.reply(`Admins bot : ${memoire.admins.map((id) => `<@${id}>`).join(", ")}`);
  }

  if (!user) {
    return message.reply("Exemple : `!droit ajouter @Alexis` ou `!droit supprimer @Alexis`");
  }

  if (action === "ajouter") {
    if (!memoire.admins.includes(user.id)) memoire.admins.push(user.id);
    sauvegarderMemoire(memoire);
    return message.reply(`${user} peut maintenant donner des ordres au bot.`);
  }

  if (action === "supprimer") {
    memoire.admins = memoire.admins.filter((id) => id !== user.id);
    sauvegarderMemoire(memoire);
    return message.reply(`${user} n’a plus les droits spécifiques du bot.`);
  }

  return message.reply("Commandes : `!droit ajouter @user`, `!droit supprimer @user`, `!droit liste`");
}

async function gererMemoire(message, texte) {
  if (!estAutorise(message)) return message.reply("Tu n’as pas les droits pour modifier ma mémoire.");
  if (!commandeAdminDansBonSalon(message)) return message.reply("Cette commande doit être utilisée dans le salon admin du bot.");

  const memoire = chargerMemoire();

  const aide = `
Commandes mémoire :
!lieu description texte
!lieu detail texte
!salle ajouter Nom | étage | description

!personne ajouter Prénom
!personne voiture Prénom texte
!personne age Prénom texte
!personne aime Prénom texte
!personne habitude Prénom texte
!personne anecdote Prénom texte
!personne limite Prénom texte
!personne fiche Prénom
!personne liste

!anecdote ajouter texte
!expression ajouter texte
!blague ajouter texte
!style bienvenue texte
!style relance texte
!memoire
`;

  if (texte === "!memoire") return message.reply(aide);

  if (texte.startsWith("!lieu description ")) {
    memoire.lieu.description = nettoyer(texte.replace("!lieu description ", ""));
    sauvegarderMemoire(memoire);
    return message.reply("Description du lieu enregistrée.");
  }

  if (texte.startsWith("!lieu detail ")) {
    memoire.lieu.details.push(nettoyer(texte.replace("!lieu detail ", "")));
    sauvegarderMemoire(memoire);
    return message.reply("Détail du lieu ajouté.");
  }

  if (texte.startsWith("!salle ajouter ")) {
    const raw = nettoyer(texte.replace("!salle ajouter ", ""));
    const [nom, etage, description] = raw.split("|").map(nettoyer);

    if (!nom) return message.reply("Exemple : `!salle ajouter Salle Océan | étage 1 | grande salle de réunion`");

    memoire.lieu.salles.push({
      nom,
      etage: etage || "",
      description: description || ""
    });

    sauvegarderMemoire(memoire);
    return message.reply(`Salle ajoutée : ${nom}`);
  }

  if (texte.startsWith("!personne liste")) {
    if (!memoire.personnes.length) return message.reply("Aucune personne enregistrée.");
    return message.reply(memoire.personnes.map((p) => `- ${p.prenom}`).join("\n"));
  }

  if (texte.startsWith("!personne fiche ")) {
    const prenom = nettoyer(texte.replace("!personne fiche ", ""));
    const personne = memoire.personnes.find((p) => p.prenom.toLowerCase() === prenom.toLowerCase());

    if (!personne) return message.reply("Personne introuvable.");

    return message.reply(`Fiche ${personne.prenom} :
Rôle : ${personne.role || "non renseigné"}
Voiture : ${personne.voiture || "non renseignée"}
Âge : ${personne.age || "non renseigné"}
Aime : ${(personne.aime || []).join(", ") || "non renseigné"}
Habitudes : ${(personne.habitudes || []).join(", ") || "non renseigné"}
Anecdotes : ${(personne.anecdotes || []).join(" / ") || "non renseigné"}
Limites : ${(personne.limites || []).join(" / ") || "aucune"}`);
  }

  if (texte.startsWith("!personne ajouter ")) {
    const prenom = nettoyer(texte.replace("!personne ajouter ", ""));
    if (!prenom) return message.reply("Exemple : `!personne ajouter Alexis`");

    trouverOuCreerPersonne(memoire, prenom);
    sauvegarderMemoire(memoire);
    return message.reply(`Personne ajoutée : ${prenom}`);
  }

  const champsPersonne = [
    { cmd: "!personne voiture ", prop: "voiture", array: false },
    { cmd: "!personne age ", prop: "age", array: false },
    { cmd: "!personne aime ", prop: "aime", array: true },
    { cmd: "!personne habitude ", prop: "habitudes", array: true },
    { cmd: "!personne anecdote ", prop: "anecdotes", array: true },
    { cmd: "!personne limite ", prop: "limites", array: true }
  ];

  for (const champ of champsPersonne) {
    if (texte.startsWith(champ.cmd)) {
      const raw = nettoyer(texte.replace(champ.cmd, ""));
      const [prenom, ...reste] = raw.split(" ");
      const valeur = nettoyer(reste.join(" "));

      if (!prenom || !valeur) {
        return message.reply(`Exemple : \`${champ.cmd}${champ.prop === "voiture" ? "Alexis Peugeot 308" : "Alexis texte"}\``);
      }

      const personne = trouverOuCreerPersonne(memoire, prenom);

      if (champ.array) {
        personne[champ.prop].push(valeur);
      } else {
        personne[champ.prop] = valeur;
      }

      sauvegarderMemoire(memoire);
      return message.reply(`Info ajoutée pour ${prenom}.`);
    }
  }

  if (texte.startsWith("!anecdote ajouter ")) {
    memoire.anecdotes.push(nettoyer(texte.replace("!anecdote ajouter ", "")));
    sauvegarderMemoire(memoire);
    return message.reply("Anecdote générale ajoutée.");
  }

  if (texte.startsWith("!expression ajouter ")) {
    memoire.expressions.push(nettoyer(texte.replace("!expression ajouter ", "")));
    sauvegarderMemoire(memoire);
    return message.reply("Expression ajoutée.");
  }

  if (texte.startsWith("!blague ajouter ")) {
    memoire.blagues.push(nettoyer(texte.replace("!blague ajouter ", "")));
    sauvegarderMemoire(memoire);
    return message.reply("Blague ajoutée.");
  }

  if (texte.startsWith("!style ")) {
    const parts = texte.split(" ");
    const style = parts[1];
    const contenu = nettoyer(parts.slice(2).join(" "));

    if (!memoire.styles[style]) memoire.styles[style] = [];
    if (!contenu) return message.reply("Exemple : `!style bienvenue Bienvenue les artistes, réunion lancée.`");

    memoire.styles[style].push(contenu);
    sauvegarderMemoire(memoire);
    return message.reply(`Style ajouté : ${style}`);
  }

  return false;
}

async function gererDire(message, texte) {
  if (!estAutorise(message)) return message.reply("Tu n’as pas les droits pour donner cet ordre.");
  if (!commandeAdminDansBonSalon(message)) return message.reply("Cette commande doit être utilisée dans le salon admin du bot.");

  const salonCible = message.mentions.channels.first();
  const userMention = message.mentions.users.first();

  if (!salonCible) {
    return message.reply("Exemple : `!dire #general @Alexis Fais une blague gentille sur les deux Alexis.`");
  }

  let instruction = texte
    .replace(/^!dire\s+/i, "")
    .replace(`<#${salonCible.id}>`, "")
    .trim();

  if (userMention) {
    instruction = instruction
      .replace(`<@${userMention.id}>`, "")
      .replace(`<@!${userMention.id}>`, "")
      .trim();
  }

  if (!instruction) return message.reply("Ajoute une instruction après le salon.");

  const contenu = await genererMessageIA({
    instruction,
    contexte: `ordre admin à envoyer dans le salon #${salonCible.name}`,
    mentionPersonne: userMention ? userMention.username : null,
    inclureMeteo: instruction.toLowerCase().includes("météo") || instruction.toLowerCase().includes("meteo")
  });

  await salonCible.send(userMention ? `${userMention} ${contenu}` : contenu);
  return message.reply(`Message envoyé dans ${salonCible}.`);
}

async function gererAnnonce(message, texte) {
  if (!estAutorise(message)) return message.reply("Tu n’as pas les droits pour faire une annonce.");
  if (!commandeAdminDansBonSalon(message)) return message.reply("Cette commande doit être utilisée dans le salon admin du bot.");

  const salonCible = message.mentions.channels.first();

  if (!salonCible) {
    return message.reply("Exemple : `!annonce #general Fais un message de bienvenue drôle.`");
  }

  const instruction = nettoyer(
    texte
      .replace(/^!annonce\s+/i, "")
      .replace(`<#${salonCible.id}>`, "")
  );

  if (!instruction) return message.reply("Ajoute une instruction après le salon.");

  const contenu = await genererMessageIA({
    instruction,
    contexte: `annonce dans le salon #${salonCible.name}`,
    style: instruction.toLowerCase().includes("bienvenue") ? "bienvenue" : "annonce",
    inclureMeteo: instruction.toLowerCase().includes("météo") || instruction.toLowerCase().includes("meteo")
  });

  await salonCible.send(contenu);
  return message.reply(`Annonce envoyée dans ${salonCible}.`);
}

async function gererQuestion(message, texte) {
  if (!estAutorise(message)) return message.reply("Tu n’as pas les droits pour lancer une question.");
  if (!commandeAdminDansBonSalon(message)) return message.reply("Cette commande doit être utilisée dans le salon admin du bot.");

  const salonCible = message.mentions.channels.first();
  const userMention = message.mentions.users.first();

  if (!salonCible || !userMention) {
    return message.reply("Exemple : `!question #general @Alexis voiture`");
  }

  const theme = nettoyer(
    texte
      .replace(/^!question\s+/i, "")
      .replace(`<#${salonCible.id}>`, "")
      .replace(`<@${userMention.id}>`, "")
      .replace(`<@!${userMention.id}>`, "")
  ) || "profil";

  const question = await genererMessageIA({
    instruction: `Pose une question courte et naturelle à cette personne pour enrichir sa fiche dans la mémoire du service. Thème demandé : ${theme}. Explique qu'elle peut répondre si elle veut, de façon légère.`,
    contexte: "question pour enrichir la mémoire du service",
    mentionPersonne: userMention.username,
    theme: "personnes"
  });

  await salonCible.send(`${userMention} ${question}`);
  return message.reply(`Question envoyée dans ${salonCible}.`);
}

async function gererMeteo(message) {
  const meteo = await getMeteoTexte();
  return message.reply(meteo);
}

function enregistrerActivite(message) {
  const now = Date.now();
  const old = salonsSuivis.get(message.channel.id);

  salonsSuivis.set(message.channel.id, {
    channel: message.channel,
    lastHumanMessageAt: now,
    lastBotMessageAt: old?.lastBotMessageAt || 0,
    nextIdleAt: now + randomMinutes(IDLE_MIN_MINUTES, IDLE_MAX_MINUTES)
  });
}

function randomMinutes(min, max) {
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 60 * 1000;
}

async function relancesSilence() {
  const now = Date.now();

  for (const [channelId, etat] of salonsSuivis.entries()) {
    if (!etat?.channel?.send) continue;
    if (now < etat.nextIdleAt) continue;
    if (now - etat.lastBotMessageAt < BOT_COOLDOWN_MS) continue;

    const contenu = await genererMessageIA({
      instruction: "Personne ne parle depuis un moment. Relance la discussion avec une phrase courte, drôle, différente des blagues précédentes. Ne parle pas forcément de café.",
      contexte: "relance automatique après silence",
      style: "relance",
      inclureMeteo: Math.random() < 0.25
    });

    await etat.channel.send(contenu);

    salonsSuivis.set(channelId, {
      ...etat,
      lastBotMessageAt: now,
      nextIdleAt: now + randomMinutes(IDLE_MIN_MINUTES, IDLE_MAX_MINUTES)
    });
  }
}

client.once("ready", () => {
  console.log(`Bot connecté : ${client.user.tag}`);
  console.log(`Modèle OpenRouter : ${OPENROUTER_MODEL}`);
  console.log(`Météo : ${WEATHER_CITY}, ${WEATHER_COUNTRY}`);
  console.log(`Chance spontanée : ${SPONTANEOUS_CHANCE}%`);
  setInterval(relancesSilence, 60 * 1000);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    const texte = message.content || "";
    const texteMin = texte.toLowerCase();

    enregistrerActivite(message);

    if (texteMin === "!aide-herve") {
      return message.reply(`
Commandes principales :
!memoire
!droit ajouter @user
!droit supprimer @user
!droit liste

!dire #salon @user instruction
!annonce #salon instruction
!question #salon @user thème
!meteo

Exemples mémoire :
!lieu description On est dans un bâtiment de deux étages avec un sous-sol.
!lieu detail Le sous-sol a une ambiance de niveau bonus.
!salle ajouter Salle Océan | étage 1 | grande salle de réunion
!personne ajouter Alexis
!personne voiture Alexis Peugeot 308
!personne aime Alexis les bugs impossibles à reproduire
!personne anecdote Alexis Il y a deux Alexis dans le service.
!expression ajouter C'est sûrement le cache.
!blague ajouter Avec deux Alexis, même l'annuaire demande une précision.
`);
    }

    if (texteMin.startsWith("!droit")) return gererDroit(message, texte);
    if (texteMin === "!meteo") return gererMeteo(message);

    if (
      texteMin.startsWith("!memoire")
      || texteMin.startsWith("!lieu")
      || texteMin.startsWith("!salle")
      || texteMin.startsWith("!personne")
      || texteMin.startsWith("!anecdote")
      || texteMin.startsWith("!expression")
      || texteMin.startsWith("!blague")
      || texteMin.startsWith("!style")
    ) {
      const handled = await gererMemoire(message, texte);
      if (handled !== false) return handled;
    }

    if (texteMin.startsWith("!dire ")) return gererDire(message, texte);
    if (texteMin.startsWith("!annonce ")) return gererAnnonce(message, texte);
    if (texteMin.startsWith("!question ")) return gererQuestion(message, texte);

    if (estSujetInterdit(texte)) return;

    const estMentionne = message.mentions.has(client.user);

    if (estMentionne) {
      const contenu = await genererMessageIA({
        instruction: texte,
        contexte: "le bot a été mentionné directement",
        inclureMeteo: texteMin.includes("météo") || texteMin.includes("meteo")
      });

      const etat = salonsSuivis.get(message.channel.id);
      if (etat) etat.lastBotMessageAt = Date.now();

      return message.reply(contenu);
    }

    const etat = salonsSuivis.get(message.channel.id);
    if (etat && Date.now() - etat.lastBotMessageAt < BOT_COOLDOWN_MS) return;

    if (!contientMotDeclencheur(texte)) return;
    if (Math.random() > SPONTANEOUS_CHANCE / 100) return;

    const contenu = await genererMessageIA({
      instruction: `Réagis à ce message de façon courte, drôle et naturelle : ${texte}`,
      contexte: "intervention spontanée dans une discussion Discord",
      inclureMeteo: Math.random() < 0.15
    });

    if (etat) etat.lastBotMessageAt = Date.now();

    return message.reply(contenu);
  } catch (error) {
    console.error("Erreur messageCreate :", error);
  }
});

client.login(DISCORD_TOKEN);