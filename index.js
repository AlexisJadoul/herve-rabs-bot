require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField
} = require("discord.js");

/**
 * =========================================================
 * CONFIG
 * =========================================================
 */

const PORT = process.env.PORT || 3000;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";

const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID || "";
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";

const WEATHER_CITY = process.env.WEATHER_CITY || "Redon";
const WEATHER_COUNTRY = process.env.WEATHER_COUNTRY || "France";

const BOT_HUMEUR = process.env.BOT_HUMEUR || "collegue";

const QUEUE_MIN_SECONDS = Number(process.env.QUEUE_MIN_SECONDS || 30);
const QUEUE_MAX_SECONDS = Number(process.env.QUEUE_MAX_SECONDS || 90);

const SPONTANEOUS_CHANCE = Number(process.env.SPONTANEOUS_CHANCE || 2);
const IDLE_MIN_MINUTES = Number(process.env.IDLE_MIN_MINUTES || 15);
const IDLE_MAX_MINUTES = Number(process.env.IDLE_MAX_MINUTES || 45);

const DATA_FILE = path.join(__dirname, "bot-data.json");

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN manquant.");
  process.exit(1);
}

if (!OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY manquant.");
  process.exit(1);
}

/**
 * =========================================================
 * MINI SERVEUR HTTP POUR HOSTINGER
 * =========================================================
 */

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Herve_RABS bot is running.");
}).listen(PORT, () => {
  console.log(`Serveur HTTP actif sur le port ${PORT}`);
});

/**
 * =========================================================
 * PROTECTIONS ANTI-CRASH
 * =========================================================
 */

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection :", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception :", error);
});

/**
 * =========================================================
 * CLIENT DISCORD
 * =========================================================
 */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const salonsSuivis = new Map();
let queueProcessing = false;
let nextQueueRunAt = 0;

/**
 * =========================================================
 * DONNÉES
 * =========================================================
 */

function defaultData() {
  return {
    admins: [],
    memory: {
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
      }
    },
    queue: [],
    history: [],
    recent: {
      themes: [],
      responses: []
    }
  };
}

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData(), null, 2), "utf8");
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const base = defaultData();

    return {
      ...base,
      ...parsed,
      admins: Array.isArray(parsed.admins) ? parsed.admins : [],
      memory: {
        ...base.memory,
        ...(parsed.memory || {}),
        lieu: {
          ...base.memory.lieu,
          ...(parsed.memory?.lieu || {})
        },
        styles: {
          ...base.memory.styles,
          ...(parsed.memory?.styles || {})
        }
      },
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
      recent: {
        ...base.recent,
        ...(parsed.recent || {})
      }
    };
  } catch (error) {
    console.error("Erreur lecture bot-data.json :", error);
    return defaultData();
  }
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

/**
 * =========================================================
 * OUTILS
 * =========================================================
 */

function nettoyer(texte) {
  return String(texte || "").replace(/\s+/g, " ").trim();
}

function createId() {
  return `task_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function heureLocale() {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    dateStyle: "full",
    timeStyle: "short"
  }).format(new Date());
}

function isDiscordAdmin(message) {
  if (!message.member) return false;

  return message.member.permissions.has(PermissionsBitField.Flags.Administrator)
    || message.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

function isAuthorized(message) {
  const data = readData();

  return isDiscordAdmin(message)
    || data.admins.includes(message.author.id);
}

function isAdminChannel(message) {
  if (!ADMIN_CHANNEL_ID) return true;
  return message.channel.id === ADMIN_CHANNEL_ID;
}

function shortText(text, max = 900) {
  const clean = nettoyer(text);
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

function getQueueDelayMs() {
  return randomBetween(QUEUE_MIN_SECONDS, QUEUE_MAX_SECONDS) * 1000;
}

/**
 * =========================================================
 * LOGS DISCORD
 * =========================================================
 */

async function getLogChannel() {
  if (!LOG_CHANNEL_ID) return null;

  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (!channel || typeof channel.send !== "function") return null;
    return channel;
  } catch (error) {
    console.error("Erreur récupération salon logs :", error);
    return null;
  }
}

async function logBot(message) {
  try {
    const channel = await getLogChannel();
    if (!channel) return;

    await channel.send(message);
  } catch (error) {
    console.error("Erreur envoi log :", error);
  }
}

async function logTaskReceived(task, position) {
  await logBot(
`📥 **Message pris en compte**
ID : \`${task.id}\`
Type : **${task.type}**
Demandé par : <@${task.requestedById}>
Salon cible : <#${task.targetChannelId}>
${task.targetUserId ? `Personne ciblée : <@${task.targetUserId}>\n` : ""}Instruction : ${shortText(task.instruction, 700)}
Statut : **en file d'attente**
Position : **${position}**`
  );
}

async function logTaskProcessing(task) {
  await logBot(
`🧠 **Je traite une tâche**
ID : \`${task.id}\`
Type : **${task.type}**
Demandé par : <@${task.requestedById}>
Salon cible : <#${task.targetChannelId}>
Tentative : **${task.attempts + 1}/3**
Instruction : ${shortText(task.instruction, 700)}`
  );
}

async function logTaskDone(task, responseText) {
  await logBot(
`✅ **Tâche traitée**
ID : \`${task.id}\`
Type : **${task.type}**
Salon : <#${task.targetChannelId}>
Message envoyé : ${shortText(responseText, 700)}`
  );
}

async function logTaskError(task, error) {
  await logBot(
`❌ **Erreur pendant le traitement**
ID : \`${task.id}\`
Type : **${task.type}**
Salon cible : <#${task.targetChannelId}>
Tentative : **${task.attempts}/3**
Erreur : \`${shortText(error?.message || String(error), 500)}\`
Statut : ${task.status === "failed" ? "**échec définitif**" : "**sera retenté plus tard**"}`
  );
}

/**
 * =========================================================
 * MÉTÉO
 * =========================================================
 */

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

/**
 * =========================================================
 * THÈMES ET SÉCURITÉ
 * =========================================================
 */

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
  "lundi",
  "discord",
  "service",
  "bretagne"
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
  "fatigue",
  "discord",
  "salon",
  "bretagne"
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
  "grossesse",
  "mot de passe",
  "password",
  "mdp"
];

function hasForbiddenTopic(text) {
  const min = String(text || "").toLowerCase();
  return sujetsInterdits.some((word) => min.includes(word));
}

function hasTriggerWord(text) {
  const min = String(text || "").toLowerCase();
  return motsDeclencheurs.some((word) => min.includes(word));
}

function chooseTheme() {
  const data = readData();
  const recent = data.recent.themes || [];

  const possible = themesDisponibles.filter((theme) => !recent.includes(theme));
  const list = possible.length ? possible : themesDisponibles;

  const theme = list[Math.floor(Math.random() * list.length)];

  data.recent.themes = [theme, ...recent].slice(0, 7);
  writeData(data);

  return theme;
}

function addRecentResponse(response) {
  if (!response) return;

  const data = readData();
  data.recent.responses = [
    nettoyer(response),
    ...(data.recent.responses || [])
  ].slice(0, 15);

  writeData(data);
}

/**
 * =========================================================
 * MÉMOIRE POUR PROMPT
 * =========================================================
 */

function getMemoryText() {
  const data = readData();
  const memory = data.memory;

  const personnes = memory.personnes.length
    ? memory.personnes.map((p) => {
      const lines = [];
      lines.push(`- ${p.prenom}`);
      if (p.role) lines.push(`  rôle : ${p.role}`);
      if (p.voiture) lines.push(`  voiture : ${p.voiture}`);
      if (p.age) lines.push(`  âge : ${p.age}`);
      if (p.aime?.length) lines.push(`  aime : ${p.aime.join(", ")}`);
      if (p.habitudes?.length) lines.push(`  habitudes : ${p.habitudes.join(", ")}`);
      if (p.anecdotes?.length) lines.push(`  anecdotes : ${p.anecdotes.join(" / ")}`);
      if (p.limites?.length) lines.push(`  limites : ${p.limites.join(" / ")}`);
      return lines.join("\n");
    }).join("\n")
    : "Aucune personne enregistrée.";

  const salles = memory.lieu.salles.length
    ? memory.lieu.salles.map((s) => {
      return `- ${s.nom} : ${s.description || ""} ${s.etage ? `(étage : ${s.etage})` : ""}`;
    }).join("\n")
    : "Aucune salle enregistrée.";

  const styles = Object.entries(memory.styles || {})
    .map(([key, values]) => {
      if (!values?.length) return null;
      return `${key} : ${values.join(" / ")}`;
    })
    .filter(Boolean)
    .join("\n") || "Aucun style enregistré.";

  return `
Lieu :
Nom : ${memory.lieu.nom}
Ville : ${memory.lieu.ville}
Description : ${memory.lieu.description || "Non renseignée"}
Détails : ${(memory.lieu.details || []).join(" / ") || "Aucun détail"}

Salles :
${salles}

Personnes :
${personnes}

Anecdotes générales :
${(memory.anecdotes || []).join(" / ") || "Aucune anecdote"}

Expressions internes :
${(memory.expressions || []).join(" / ") || "Aucune expression"}

Blagues enregistrées :
${(memory.blagues || []).join(" / ") || "Aucune blague"}

Styles de messages :
${styles}

Derniers thèmes utilisés :
${(data.recent.themes || []).join(" / ") || "Aucun"}

Dernières réponses à éviter :
${(data.recent.responses || []).join(" / ") || "Aucune"}
`;
}

/**
 * =========================================================
 * OPENROUTER
 * =========================================================
 */

async function appelerOpenRouter(messages, maxTokens = 180, temperature = 0.85) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
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

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Erreur OpenRouter :", errorText);
      throw new Error(`OpenRouter error: ${errorText.slice(0, 300)}`);
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || "";
  } catch (error) {
    clearTimeout(timeout);
    console.error("Erreur appel OpenRouter :", error);
    throw error;
  }
}

async function genererMessageIA(task) {
  const meteo = task.includeWeather ? await getMeteoTexte() : "";
  const theme = task.theme || chooseTheme();

  const system = `
Tu es Hervé_RABS, un personnage fictif de serveur Discord.
Tu joues le rôle humoristique d'un collègue développeur en télétravail en Bretagne.
Tu parles naturellement, comme quelqu'un du service.
Tu peux être drôle, taquin, un peu absurde, mais jamais méchant.

Règles :
- Si on te demande directement si tu es un bot, tu réponds honnêtement que tu es un personnage/bot du serveur.
- Ne prétends pas être une vraie personne réelle.
- Ne fais pas de blague sur le physique, la santé, la vie privée, l'argent, la religion, la politique, le handicap, l'origine ou les sujets sensibles.
- Ne fais pas de blague sur la calvitie, le poids, l'âge de façon moqueuse ou l'apparence physique.
- Ne parle pas toujours de café.
- Varie les thèmes.
- Ne répète pas les réponses récentes.
- Maximum 2 phrases.
- Réponds uniquement avec le message final à envoyer sur Discord.

Humeur actuelle : ${BOT_HUMEUR}
Heure actuelle : ${heureLocale()}
Météo : ${meteo || "Non demandée pour ce message."}
Thème à utiliser : ${theme}
Type de tâche : ${task.type}
Style demandé : ${task.style || "naturel"}

Mémoire du service :
${getMemoryText()}
`;

  const user = `
Instruction :
${task.instruction}

${task.targetUserId ? `Personne concernée : <@${task.targetUserId}>` : "Personne concernée : aucune"}
`;

  const response = await appelerOpenRouter([
    { role: "system", content: system },
    { role: "user", content: user }
  ]);

  addRecentResponse(response);

  return response;
}

/**
 * =========================================================
 * FILE D'ATTENTE
 * =========================================================
 */

function addTask(task) {
  const data = readData();

  const fullTask = {
    id: createId(),
    type: task.type,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    requestedById: task.requestedById,
    requestedByName: task.requestedByName,
    sourceChannelId: task.sourceChannelId,
    targetChannelId: task.targetChannelId,
    targetUserId: task.targetUserId || null,
    instruction: task.instruction,
    includeWeather: Boolean(task.includeWeather),
    style: task.style || "",
    theme: task.theme || "",
    attempts: 0,
    nextTryAt: Date.now(),
    lastError: ""
  };

  data.queue.push(fullTask);
  writeData(data);

  return {
    task: fullTask,
    position: data.queue.filter((t) => t.status === "pending").length
  };
}

function updateTask(taskId, patch) {
  const data = readData();
  const index = data.queue.findIndex((t) => t.id === taskId);

  if (index === -1) return null;

  data.queue[index] = {
    ...data.queue[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };

  writeData(data);

  return data.queue[index];
}

function removeTask(taskId) {
  const data = readData();
  data.queue = data.queue.filter((t) => t.id !== taskId);
  writeData(data);
}

function addHistory(task, responseText) {
  const data = readData();

  data.history.unshift({
    id: task.id,
    type: task.type,
    targetChannelId: task.targetChannelId,
    targetUserId: task.targetUserId,
    requestedById: task.requestedById,
    instruction: task.instruction,
    response: responseText,
    date: new Date().toISOString()
  });

  data.history = data.history.slice(0, 50);
  writeData(data);
}

async function processOneTask() {
  if (queueProcessing) return;

  const now = Date.now();
  if (now < nextQueueRunAt) return;

  const data = readData();
  const task = data.queue.find((t) => {
    return t.status === "pending" && Number(t.nextTryAt || 0) <= Date.now();
  });

  if (!task) return;

  queueProcessing = true;
  nextQueueRunAt = Date.now() + getQueueDelayMs();

  try {
    const processingTask = updateTask(task.id, {
      status: "processing",
      attempts: Number(task.attempts || 0) + 1
    });

    await logTaskProcessing(processingTask);

    const targetChannel = await client.channels.fetch(processingTask.targetChannelId);

    if (!targetChannel || typeof targetChannel.send !== "function") {
      throw new Error("Salon cible introuvable ou non compatible.");
    }

    const responseText = await genererMessageIA(processingTask);

    if (!responseText) {
      throw new Error("Réponse IA vide.");
    }

    const content = processingTask.targetUserId
      ? `<@${processingTask.targetUserId}> ${responseText}`
      : responseText;

    await targetChannel.send({
      content,
      allowedMentions: {
        users: processingTask.targetUserId ? [processingTask.targetUserId] : [],
        parse: []
      }
    });

    addHistory(processingTask, responseText);
    removeTask(processingTask.id);

    await logTaskDone(processingTask, responseText);
  } catch (error) {
    console.error("Erreur traitement tâche :", error);

    const current = readData().queue.find((t) => t.id === task.id);
    const attempts = Number(current?.attempts || 1);

    if (attempts >= 3) {
      const failed = updateTask(task.id, {
        status: "failed",
        lastError: error.message || String(error)
      });

      await logTaskError(failed || task, error);
    } else {
      const retryTask = updateTask(task.id, {
        status: "pending",
        nextTryAt: Date.now() + 2 * 60 * 1000,
        lastError: error.message || String(error)
      });

      await logTaskError(retryTask || task, error);
    }
  } finally {
    queueProcessing = false;
  }
}

function startQueueWorker() {
  setInterval(() => {
    processOneTask().catch((error) => {
      console.error("Erreur worker queue :", error);
    });
  }, 5000);
}

/**
 * =========================================================
 * MÉMOIRE COMMANDES
 * =========================================================
 */

function findOrCreatePerson(data, prenom) {
  const clean = nettoyer(prenom);
  const existing = data.memory.personnes.find((p) => {
    return p.prenom.toLowerCase() === clean.toLowerCase();
  });

  if (existing) return existing;

  const person = {
    prenom: clean,
    role: "",
    voiture: "",
    age: "",
    aime: [],
    habitudes: [],
    anecdotes: [],
    limites: []
  };

  data.memory.personnes.push(person);
  return person;
}

async function handleDroit(message, texte) {
  if (!isDiscordAdmin(message)) {
    return message.reply("Seuls les admins Discord peuvent gérer les droits du bot.");
  }

  const data = readData();
  const action = texte.split(" ")[1];
  const user = message.mentions.users.first();

  if (action === "liste") {
    if (!data.admins.length) {
      return message.reply("Aucun droit spécifique ajouté.");
    }

    return message.reply(`Admins bot : ${data.admins.map((id) => `<@${id}>`).join(", ")}`);
  }

  if (!user) {
    return message.reply("Exemple : `!droit ajouter @user` ou `!droit supprimer @user`");
  }

  if (action === "ajouter") {
    if (!data.admins.includes(user.id)) {
      data.admins.push(user.id);
    }

    writeData(data);
    return message.reply(`${user} peut maintenant donner des ordres au bot.`);
  }

  if (action === "supprimer") {
    data.admins = data.admins.filter((id) => id !== user.id);
    writeData(data);
    return message.reply(`${user} n’a plus les droits spécifiques du bot.`);
  }

  return message.reply("Commandes : `!droit ajouter @user`, `!droit supprimer @user`, `!droit liste`");
}

async function handleMemory(message, texte) {
  if (!isAuthorized(message)) {
    return message.reply("Tu n’as pas les droits pour modifier ma mémoire.");
  }

  if (!isAdminChannel(message)) {
    return message.reply("Cette commande doit être utilisée dans le salon admin du bot.");
  }

  const data = readData();

  if (texte === "!memoire") {
    return message.reply(
`Commandes mémoire :
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
!style relance texte`
    );
  }

  if (texte.startsWith("!lieu description ")) {
    data.memory.lieu.description = nettoyer(texte.replace("!lieu description ", ""));
    writeData(data);
    return message.reply("Description du lieu enregistrée.");
  }

  if (texte.startsWith("!lieu detail ")) {
    data.memory.lieu.details.push(nettoyer(texte.replace("!lieu detail ", "")));
    writeData(data);
    return message.reply("Détail du lieu ajouté.");
  }

  if (texte.startsWith("!salle ajouter ")) {
    const raw = nettoyer(texte.replace("!salle ajouter ", ""));
    const [nom, etage, description] = raw.split("|").map(nettoyer);

    if (!nom) {
      return message.reply("Exemple : `!salle ajouter Salle Océan | étage 1 | grande salle de réunion`");
    }

    data.memory.lieu.salles.push({
      nom,
      etage: etage || "",
      description: description || ""
    });

    writeData(data);
    return message.reply(`Salle ajoutée : ${nom}`);
  }

  if (texte.startsWith("!personne liste")) {
    if (!data.memory.personnes.length) {
      return message.reply("Aucune personne enregistrée.");
    }

    return message.reply(data.memory.personnes.map((p) => `- ${p.prenom}`).join("\n"));
  }

  if (texte.startsWith("!personne fiche ")) {
    const prenom = nettoyer(texte.replace("!personne fiche ", ""));
    const person = data.memory.personnes.find((p) => {
      return p.prenom.toLowerCase() === prenom.toLowerCase();
    });

    if (!person) {
      return message.reply("Personne introuvable.");
    }

    return message.reply(
`Fiche ${person.prenom}
Rôle : ${person.role || "non renseigné"}
Voiture : ${person.voiture || "non renseignée"}
Âge : ${person.age || "non renseigné"}
Aime : ${(person.aime || []).join(", ") || "non renseigné"}
Habitudes : ${(person.habitudes || []).join(", ") || "non renseigné"}
Anecdotes : ${(person.anecdotes || []).join(" / ") || "non renseigné"}
Limites : ${(person.limites || []).join(" / ") || "aucune"}`
    );
  }

  if (texte.startsWith("!personne ajouter ")) {
    const prenom = nettoyer(texte.replace("!personne ajouter ", ""));
    if (!prenom) return message.reply("Exemple : `!personne ajouter Alexis`");

    findOrCreatePerson(data, prenom);
    writeData(data);

    return message.reply(`Personne ajoutée : ${prenom}`);
  }

  const personFields = [
    { cmd: "!personne voiture ", prop: "voiture", array: false },
    { cmd: "!personne age ", prop: "age", array: false },
    { cmd: "!personne aime ", prop: "aime", array: true },
    { cmd: "!personne habitude ", prop: "habitudes", array: true },
    { cmd: "!personne anecdote ", prop: "anecdotes", array: true },
    { cmd: "!personne limite ", prop: "limites", array: true }
  ];

  for (const field of personFields) {
    if (texte.startsWith(field.cmd)) {
      const raw = nettoyer(texte.replace(field.cmd, ""));
      const [prenom, ...rest] = raw.split(" ");
      const value = nettoyer(rest.join(" "));

      if (!prenom || !value) {
        return message.reply(`Exemple : \`${field.cmd}Alexis texte\``);
      }

      const person = findOrCreatePerson(data, prenom);

      if (field.array) {
        person[field.prop].push(value);
      } else {
        person[field.prop] = value;
      }

      writeData(data);
      return message.reply(`Info ajoutée pour ${prenom}.`);
    }
  }

  if (texte.startsWith("!anecdote ajouter ")) {
    data.memory.anecdotes.push(nettoyer(texte.replace("!anecdote ajouter ", "")));
    writeData(data);
    return message.reply("Anecdote générale ajoutée.");
  }

  if (texte.startsWith("!expression ajouter ")) {
    data.memory.expressions.push(nettoyer(texte.replace("!expression ajouter ", "")));
    writeData(data);
    return message.reply("Expression ajoutée.");
  }

  if (texte.startsWith("!blague ajouter ")) {
    data.memory.blagues.push(nettoyer(texte.replace("!blague ajouter ", "")));
    writeData(data);
    return message.reply("Blague ajoutée.");
  }

  if (texte.startsWith("!style ")) {
    const parts = texte.split(" ");
    const style = parts[1];
    const content = nettoyer(parts.slice(2).join(" "));

    if (!style || !content) {
      return message.reply("Exemple : `!style bienvenue Bienvenue les artistes, réunion lancée.`");
    }

    if (!data.memory.styles[style]) {
      data.memory.styles[style] = [];
    }

    data.memory.styles[style].push(content);
    writeData(data);

    return message.reply(`Style ajouté : ${style}`);
  }

  return false;
}

/**
 * =========================================================
 * COMMANDES QUEUE
 * =========================================================
 */

async function handleQueue(message, texte) {
  if (!isAuthorized(message)) {
    return message.reply("Tu n’as pas les droits pour gérer la file.");
  }

  const data = readData();

  if (texte === "!queue vider") {
    data.queue = [];
    writeData(data);

    await logBot(`🧹 **File d'attente vidée** par <@${message.author.id}>`);
    return message.reply("File d’attente vidée.");
  }

  const active = data.queue.filter((t) => t.status !== "done");

  if (!active.length) {
    return message.reply("File d’attente vide.");
  }

  const lines = active.slice(0, 10).map((t, index) => {
    return `${index + 1}. ${t.status} - ${t.type} vers <#${t.targetChannelId}> - ${shortText(t.instruction, 90)}`;
  });

  return message.reply(`File d’attente :\n${lines.join("\n")}`);
}

async function handleHistory(message) {
  if (!isAuthorized(message)) {
    return message.reply("Tu n’as pas les droits pour voir l’historique.");
  }

  const data = readData();

  if (!data.history.length) {
    return message.reply("Historique vide.");
  }

  const lines = data.history.slice(0, 10).map((h, index) => {
    return `${index + 1}. ${h.type} vers <#${h.targetChannelId}> - ${shortText(h.response, 100)}`;
  });

  return message.reply(`Derniers messages envoyés :\n${lines.join("\n")}`);
}

async function enqueueCommandTask(message, task) {
  if (!isAuthorized(message)) {
    return message.reply("Tu n’as pas les droits pour donner cet ordre.");
  }

  if (!isAdminChannel(message)) {
    return message.reply("Cette commande doit être utilisée dans le salon admin du bot.");
  }

  const { task: createdTask, position } = addTask({
    ...task,
    requestedById: message.author.id,
    requestedByName: message.author.username,
    sourceChannelId: message.channel.id
  });

  await logTaskReceived(createdTask, position);

  return message.reply(`C’est noté, je mets ça dans ma file. Position : ${position}.`);
}

async function handleDire(message, texte) {
  const channel = message.mentions.channels.first();
  const user = message.mentions.users.first();

  if (!channel) {
    return message.reply("Exemple : `!dire #general @Alexis Fais une blague gentille.`");
  }

  let instruction = texte
    .replace(/^!dire\s+/i, "")
    .replace(`<#${channel.id}>`, "")
    .trim();

  if (user) {
    instruction = instruction
      .replace(`<@${user.id}>`, "")
      .replace(`<@!${user.id}>`, "")
      .trim();
  }

  if (!instruction) {
    return message.reply("Ajoute une instruction après le salon.");
  }

  return enqueueCommandTask(message, {
    type: "dire",
    targetChannelId: channel.id,
    targetUserId: user ? user.id : null,
    instruction,
    includeWeather: instruction.toLowerCase().includes("météo") || instruction.toLowerCase().includes("meteo"),
    style: "message ciblé"
  });
}

async function handleAnnonce(message, texte) {
  const channel = message.mentions.channels.first();

  if (!channel) {
    return message.reply("Exemple : `!annonce #general Fais un message de bienvenue drôle.`");
  }

  let instruction = texte
    .replace(/^!annonce\s+/i, "")
    .replace(`<#${channel.id}>`, "")
    .replace("@everyone", "")
    .replace("@here", "")
    .trim();

  if (!instruction) {
    return message.reply("Ajoute une instruction après le salon.");
  }

  return enqueueCommandTask(message, {
    type: "annonce",
    targetChannelId: channel.id,
    targetUserId: null,
    instruction,
    includeWeather: instruction.toLowerCase().includes("météo") || instruction.toLowerCase().includes("meteo"),
    style: instruction.toLowerCase().includes("bienvenue") ? "bienvenue" : "annonce"
  });
}

async function handleQuestion(message, texte) {
  const channel = message.mentions.channels.first();
  const user = message.mentions.users.first();

  if (!channel || !user) {
    return message.reply("Exemple : `!question #general @Alexis voiture`");
  }

  const theme = nettoyer(
    texte
      .replace(/^!question\s+/i, "")
      .replace(`<#${channel.id}>`, "")
      .replace(`<@${user.id}>`, "")
      .replace(`<@!${user.id}>`, "")
  ) || "profil";

  return enqueueCommandTask(message, {
    type: "question",
    targetChannelId: channel.id,
    targetUserId: user.id,
    instruction: `Pose une question courte et naturelle pour enrichir la mémoire du service. Thème demandé : ${theme}. La personne peut répondre si elle veut.`,
    includeWeather: false,
    style: "question légère",
    theme: "personnes"
  });
}

/**
 * =========================================================
 * ACTIVITÉ ET RELANCES
 * =========================================================
 */

function registerActivity(message) {
  const now = Date.now();
  const old = salonsSuivis.get(message.channel.id);

  salonsSuivis.set(message.channel.id, {
    channelId: message.channel.id,
    channelName: message.channel.name,
    lastHumanMessageAt: now,
    nextIdleAt: now + randomBetween(IDLE_MIN_MINUTES, IDLE_MAX_MINUTES) * 60 * 1000
  });
}

async function enqueueIdleTasks() {
  const now = Date.now();

  for (const [, state] of salonsSuivis.entries()) {
    if (now < state.nextIdleAt) continue;

    const data = readData();
    const alreadyQueuedForChannel = data.queue.some((task) => {
      return task.status === "pending"
        && task.type === "relance"
        && task.targetChannelId === state.channelId;
    });

    if (alreadyQueuedForChannel) continue;

    const { task, position } = addTask({
      type: "relance",
      requestedById: client.user.id,
      requestedByName: "Hervé_RABS",
      sourceChannelId: state.channelId,
      targetChannelId: state.channelId,
      targetUserId: null,
      instruction: "Personne ne parle depuis un moment. Relance la conversation avec une phrase courte, drôle et naturelle. Ne parle pas forcément de café.",
      includeWeather: Math.random() < 0.2,
      style: "relance",
      theme: "silence"
    });

    await logTaskReceived(task, position);

    salonsSuivis.set(state.channelId, {
      ...state,
      nextIdleAt: now + randomBetween(IDLE_MIN_MINUTES, IDLE_MAX_MINUTES) * 60 * 1000
    });
  }
}

/**
 * =========================================================
 * EVENTS
 * =========================================================
 */

client.once("clientReady", () => {
  console.log(`Bot connecté : ${client.user.tag}`);
  console.log(`Modèle OpenRouter : ${OPENROUTER_MODEL}`);
  console.log(`Météo : ${WEATHER_CITY}, ${WEATHER_COUNTRY}`);
  console.log(`Salon admin : ${ADMIN_CHANNEL_ID || "non défini"}`);
  console.log(`Salon logs : ${LOG_CHANNEL_ID || "non défini"}`);
  console.log(`Queue : ${QUEUE_MIN_SECONDS}s à ${QUEUE_MAX_SECONDS}s`);

  logBot(
`🟢 **Hervé_RABS est en ligne**
Modèle : \`${OPENROUTER_MODEL}\`
Salon admin : ${ADMIN_CHANNEL_ID ? `<#${ADMIN_CHANNEL_ID}>` : "non défini"}
Délai file : ${QUEUE_MIN_SECONDS}s à ${QUEUE_MAX_SECONDS}s`
  );

  startQueueWorker();

  setInterval(() => {
    enqueueIdleTasks().catch((error) => {
      console.error("Erreur relance idle :", error);
    });
  }, 60 * 1000);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    const texte = message.content || "";
    const texteMin = texte.toLowerCase();

    console.log(`Message reçu dans #${message.channel.name} par ${message.author.username} : ${texte}`);

    registerActivity(message);

    if (texteMin === "!ping") {
      return message.reply("pong");
    }

    if (texteMin === "!aide-herve") {
      return message.reply(
`Commandes principales :
!ping
!meteo
!queue
!queue vider
!history

!droit ajouter @user
!droit supprimer @user
!droit liste

!dire #salon @user instruction
!annonce #salon instruction
!question #salon @user thème

Mémoire :
!memoire
!lieu description texte
!lieu detail texte
!salle ajouter Nom | étage | description
!personne ajouter Prénom
!personne voiture Prénom texte
!personne aime Prénom texte
!personne anecdote Prénom texte
!expression ajouter texte
!blague ajouter texte`
      );
    }

    if (texteMin === "!meteo") {
      return message.reply(await getMeteoTexte());
    }

    if (texteMin.startsWith("!droit")) {
      return handleDroit(message, texte);
    }

    if (texteMin === "!queue" || texteMin === "!queue vider") {
      return handleQueue(message, texteMin);
    }

    if (texteMin === "!history") {
      return handleHistory(message);
    }

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
      const result = await handleMemory(message, texte);
      if (result !== false) return result;
    }

    if (texteMin.startsWith("!dire ")) {
      return handleDire(message, texte);
    }

    if (texteMin.startsWith("!annonce ")) {
      return handleAnnonce(message, texte);
    }

    if (texteMin.startsWith("!question ")) {
      return handleQuestion(message, texte);
    }

    if (hasForbiddenTopic(texte)) return;

    const mentioned = message.mentions.has(client.user);

    if (mentioned) {
      const { task, position } = addTask({
        type: "mention",
        requestedById: message.author.id,
        requestedByName: message.author.username,
        sourceChannelId: message.channel.id,
        targetChannelId: message.channel.id,
        targetUserId: message.author.id,
        instruction: texte,
        includeWeather: texteMin.includes("météo") || texteMin.includes("meteo"),
        style: "réponse à mention"
      });

      await logTaskReceived(task, position);
      return;
    }

    if (hasTriggerWord(texte) && Math.random() < SPONTANEOUS_CHANCE / 100) {
      const { task, position } = addTask({
        type: "spontane",
        requestedById: message.author.id,
        requestedByName: message.author.username,
        sourceChannelId: message.channel.id,
        targetChannelId: message.channel.id,
        targetUserId: null,
        instruction: `Réagis à ce message de façon courte, drôle et naturelle : ${texte}`,
        includeWeather: Math.random() < 0.15,
        style: "spontané"
      });

      await logTaskReceived(task, position);
    }
  } catch (error) {
    console.error("Erreur messageCreate :", error);
  }
});

client.login(DISCORD_TOKEN).catch((error) => {
  console.error("Erreur connexion Discord :", error);
});