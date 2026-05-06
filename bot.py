import os
import sqlite3
import logging
from datetime import datetime
from typing import Optional, List, Dict

import aiohttp
import discord
from discord.ext import commands
from dotenv import load_dotenv


# ======================================================
# CONFIGURATION
# ======================================================

load_dotenv()

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN", "").strip()
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "mistralai/mistral-7b-instruct:free").strip()

BOT_NAME = os.getenv("BOT_NAME", "Hervé").strip()
WORKPLACE = os.getenv("WORKPLACE", "l'entreprise").strip()
BOT_PERSONALITY = os.getenv(
    "BOT_PERSONALITY",
    "Tu es un collègue virtuel drôle, humain, bienveillant, un peu taquin mais jamais méchant."
).strip()

ADMIN_CHANNEL_ID = int(os.getenv("ADMIN_CHANNEL_ID", "0") or 0)

BOT_ADMIN_IDS = [
    int(x.strip())
    for x in os.getenv("BOT_ADMIN_IDS", "").split(",")
    if x.strip().isdigit()
]

ALLOWED_CHANNEL_IDS = [
    int(x.strip())
    for x in os.getenv("ALLOWED_CHANNEL_IDS", "").split(",")
    if x.strip().isdigit()
]

WEATHER_LAT = os.getenv("WEATHER_LAT", "47.6514").strip()
WEATHER_LON = os.getenv("WEATHER_LON", "-2.0848").strip()
WEATHER_CITY = os.getenv("WEATHER_CITY", "Redon").strip()

DATABASE_PATH = "collegues.db"

BOT_ERROR_MESSAGE = "J'ai un chat dans la gorge et je crois qu'il a chié."

if not DISCORD_TOKEN:
    raise RuntimeError("DISCORD_TOKEN est manquant dans le fichier .env")

if not OPENROUTER_API_KEY:
    raise RuntimeError("OPENROUTER_API_KEY est manquant dans le fichier .env")


# ======================================================
# LOGS
# ======================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s"
)

logger = logging.getLogger("discord-collegues-bot")


# ======================================================
# BASE DE DONNÉES SQLITE
# ======================================================

def get_db():
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS colleagues (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                discord_id TEXT UNIQUE,
                display_name TEXT NOT NULL,
                first_name TEXT,
                car TEXT,
                approximate_location TEXT,
                workplace TEXT,
                humor_style TEXT,
                notes TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                colleague_id INTEGER,
                memory TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(colleague_id) REFERENCES colleagues(id) ON DELETE CASCADE
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS bot_memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                memory TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)

        conn.commit()


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def upsert_colleague(
    discord_id: str,
    display_name: str,
    first_name: Optional[str] = None,
    car: Optional[str] = None,
    approximate_location: Optional[str] = None,
    workplace: Optional[str] = None,
    humor_style: Optional[str] = None,
    notes: Optional[str] = None
):
    current_time = now_iso()

    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM colleagues WHERE discord_id = ?",
            (discord_id,)
        ).fetchone()

        if existing:
            conn.execute("""
                UPDATE colleagues
                SET display_name = ?,
                    first_name = COALESCE(NULLIF(?, ''), first_name),
                    car = COALESCE(NULLIF(?, ''), car),
                    approximate_location = COALESCE(NULLIF(?, ''), approximate_location),
                    workplace = COALESCE(NULLIF(?, ''), workplace),
                    humor_style = COALESCE(NULLIF(?, ''), humor_style),
                    notes = COALESCE(NULLIF(?, ''), notes),
                    updated_at = ?
                WHERE discord_id = ?
            """, (
                display_name,
                first_name or "",
                car or "",
                approximate_location or "",
                workplace or "",
                humor_style or "",
                notes or "",
                current_time,
                discord_id
            ))
        else:
            conn.execute("""
                INSERT INTO colleagues (
                    discord_id,
                    display_name,
                    first_name,
                    car,
                    approximate_location,
                    workplace,
                    humor_style,
                    notes,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                discord_id,
                display_name,
                first_name,
                car,
                approximate_location,
                workplace,
                humor_style,
                notes,
                current_time,
                current_time
            ))

        conn.commit()


def get_colleague_by_discord_id(discord_id: str) -> Optional[sqlite3.Row]:
    with get_db() as conn:
        return conn.execute(
            "SELECT * FROM colleagues WHERE discord_id = ?",
            (discord_id,)
        ).fetchone()


def list_colleagues() -> List[sqlite3.Row]:
    with get_db() as conn:
        return conn.execute("""
            SELECT *
            FROM colleagues
            ORDER BY display_name ASC
        """).fetchall()


def add_memory_for_colleague(colleague_id: int, memory: str):
    with get_db() as conn:
        conn.execute("""
            INSERT INTO memories (colleague_id, memory, created_at)
            VALUES (?, ?, ?)
        """, (colleague_id, memory, now_iso()))
        conn.commit()


def get_memories_for_colleague(colleague_id: int, limit: int = 10) -> List[sqlite3.Row]:
    with get_db() as conn:
        return conn.execute("""
            SELECT *
            FROM memories
            WHERE colleague_id = ?
            ORDER BY id DESC
            LIMIT ?
        """, (colleague_id, limit)).fetchall()


def add_bot_memory(memory: str):
    with get_db() as conn:
        conn.execute("""
            INSERT INTO bot_memories (memory, created_at)
            VALUES (?, ?)
        """, (memory, now_iso()))
        conn.commit()


def get_bot_memories(limit: int = 20) -> List[sqlite3.Row]:
    with get_db() as conn:
        return conn.execute("""
            SELECT *
            FROM bot_memories
            ORDER BY id DESC
            LIMIT ?
        """, (limit,)).fetchall()


# ======================================================
# MÉTÉO
# ======================================================

def weather_code_to_text(code: int) -> str:
    codes = {
        0: "grand ciel dégagé",
        1: "plutôt beau",
        2: "un peu nuageux",
        3: "bien couvert",
        45: "brouillard",
        48: "brouillard givrant",
        51: "petite bruine",
        53: "bruine modérée",
        55: "bonne bruine",
        61: "petite pluie",
        63: "pluie modérée",
        65: "grosse pluie",
        71: "un peu de neige",
        73: "neige modérée",
        75: "grosse neige",
        80: "averses légères",
        81: "averses",
        82: "grosses averses",
        95: "orage",
        96: "orage avec grêle",
        99: "gros orage avec grêle",
    }

    return codes.get(code, "météo un peu bizarre")


async def get_weather_context() -> str:
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={WEATHER_LAT}"
        f"&longitude={WEATHER_LON}"
        "&current=temperature_2m,precipitation,rain,weather_code,wind_speed_10m"
        "&timezone=Europe%2FParis"
    )

    try:
        timeout = aiohttp.ClientTimeout(total=15)

        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as response:
                if response.status != 200:
                    return "Météo indisponible."

                data = await response.json()
                current = data.get("current", {})

                temperature = current.get("temperature_2m")
                rain = current.get("rain", 0)
                precipitation = current.get("precipitation", 0)
                wind = current.get("wind_speed_10m")
                code = current.get("weather_code")

                weather_text = weather_code_to_text(int(code)) if code is not None else "météo inconnue"

                if rain and rain > 0:
                    rain_text = "Il flotte, mais bon, on est en Bretagne donc personne n’est vraiment surpris."
                elif precipitation and precipitation > 0:
                    rain_text = "Il tombe un petit truc du ciel, ambiance Bretagne classique."
                else:
                    rain_text = "Il ne pleut pas pour l’instant, événement presque historique."

                return (
                    f"Météo actuelle à {WEATHER_CITY} : "
                    f"{weather_text}, {temperature}°C, vent à {wind} km/h. "
                    f"{rain_text}"
                )

    except Exception as e:
        logger.warning("Erreur météo: %s", e)
        return "Météo indisponible."


# ======================================================
# OPENROUTER
# ======================================================

async def ask_openrouter(messages: List[Dict[str, str]]) -> str:
    url = "https://openrouter.ai/api/v1/chat/completions"

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "X-OpenRouter-Title": "Discord Collegues Bot"
    }

    payload = {
        "model": OPENROUTER_MODEL,
        "messages": messages,
        "temperature": 0.9,
        "max_tokens": 700
    }

    timeout = aiohttp.ClientTimeout(total=60)

    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=headers, json=payload) as response:
                data = await response.json()

                if response.status != 200:
                    logger.error("Erreur OpenRouter: %s", data)
                    return BOT_ERROR_MESSAGE

                try:
                    return data["choices"][0]["message"]["content"].strip()
                except Exception:
                    logger.error("Réponse OpenRouter inattendue: %s", data)
                    return BOT_ERROR_MESSAGE

    except Exception as e:
        logger.error("Erreur appel OpenRouter: %s", e)
        return BOT_ERROR_MESSAGE


# ======================================================
# DISCORD
# ======================================================

intents = discord.Intents.default()
intents.message_content = True
intents.members = True

bot = commands.Bot(command_prefix="!", intents=intents)


def is_admin_user(user: discord.User | discord.Member) -> bool:
    if user.id in BOT_ADMIN_IDS:
        return True

    if isinstance(user, discord.Member):
        return user.guild_permissions.manage_guild or user.guild_permissions.administrator

    return False


def channel_allowed(message: discord.Message) -> bool:
    if not ALLOWED_CHANNEL_IDS:
        return True

    return message.channel.id in ALLOWED_CHANNEL_IDS


def should_answer(message: discord.Message) -> bool:
    if message.author.bot:
        return False

    if not channel_allowed(message):
        return False

    if bot.user and bot.user in message.mentions:
        return True

    if message.reference and message.reference.resolved:
        ref = message.reference.resolved
        if isinstance(ref, discord.Message) and ref.author.id == bot.user.id:
            return True

    return False


def format_colleague_context(colleague: sqlite3.Row) -> str:
    memories = get_memories_for_colleague(colleague["id"], limit=8)

    lines = [
        f"Nom Discord : {colleague['display_name']}",
        f"Prénom : {colleague['first_name'] or 'non renseigné'}",
        f"Voiture : {colleague['car'] or 'non renseigné'}",
        f"Habite vers : {colleague['approximate_location'] or 'non renseigné'}",
        f"Travaille à : {colleague['workplace'] or 'non renseigné'}",
        f"Style d’humour accepté : {colleague['humor_style'] or 'gentil et léger'}",
        f"Notes : {colleague['notes'] or 'aucune'}",
    ]

    if memories:
        lines.append("Anecdotes connues :")
        for memory in memories:
            lines.append(f"- {memory['memory']}")

    return "\n".join(lines)


async def build_ai_messages(message: discord.Message) -> List[Dict[str, str]]:
    author_colleague = get_colleague_by_discord_id(str(message.author.id))
    author_context = format_colleague_context(author_colleague) if author_colleague else "Aucun contexte connu pour l’auteur."

    mentioned_contexts = []

    for user in message.mentions:
        if bot.user and user.id == bot.user.id:
            continue

        colleague = get_colleague_by_discord_id(str(user.id))
        if colleague:
            mentioned_contexts.append(format_colleague_context(colleague))

    bot_memories = get_bot_memories(limit=15)

    general_memories = "\n".join(
        f"- {m['memory']}" for m in bot_memories
    ) or "Aucun souvenir général."

    weather_context = await get_weather_context()

    recent_messages = []

    try:
        async for msg in message.channel.history(limit=12, before=message):
            if msg.author.bot and bot.user and msg.author.id != bot.user.id:
                continue

            clean_content = msg.clean_content.strip()
            if clean_content:
                recent_messages.append(f"{msg.author.display_name}: {clean_content}")

        recent_messages.reverse()

    except Exception as e:
        logger.warning("Impossible de lire l'historique: %s", e)

    mentioned_context_text = "\n\n".join(mentioned_contexts) or "Aucun contexte particulier sur les personnes mentionnées."
    recent_context_text = "\n".join(recent_messages) or "Pas d’historique récent disponible."

    system_prompt = f"""
Tu es {BOT_NAME}, un bot Discord intégré dans une conversation entre collègues.

Personnalité :
{BOT_PERSONALITY}

Contexte global :
- Lieu de travail principal : {WORKPLACE}
- Tu réponds comme un collègue humain, naturel et détendu.
- Tu peux faire des blagues, mais elles doivent rester gentilles, jamais humiliantes.
- Tu ne dois pas inventer de faits personnels.
- Tu ne dois pas révéler brutalement une information privée.
- Tu évites les sujets sensibles : santé, politique, religion, orientation sexuelle, finances personnelles.
- Si une information n’est pas dans le contexte, tu peux improviser une réponse drôle mais sans faire semblant de savoir.
- Tu peux utiliser la météo si ça colle à la conversation.
- Réponds en français.
- Fais des réponses courtes ou moyennes, adaptées à Discord.
- Ne mets pas de grands pavés sauf si on te le demande.

Météo :
{weather_context}

Souvenirs généraux du bot :
{general_memories}
""".strip()

    user_prompt = f"""
Message reçu :
{message.clean_content}

Auteur :
{message.author.display_name}

Contexte connu sur l’auteur :
{author_context}

Contexte connu sur les personnes mentionnées :
{mentioned_context_text}

Messages récents du salon :
{recent_context_text}

Réponds maintenant comme {BOT_NAME}.
""".strip()

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt}
    ]


# ======================================================
# ÉVÉNEMENTS
# ======================================================

@bot.event
async def on_ready():
    init_db()
    logger.info("Bot connecté en tant que %s", bot.user)


@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return

    await bot.process_commands(message)

    if message.content.startswith("!"):
        return

    if not should_answer(message):
        return

    try:
        async with message.channel.typing():
            ai_messages = await build_ai_messages(message)
            answer = await ask_openrouter(ai_messages)

            if len(answer) > 1900:
                answer = answer[:1900] + "..."

            await message.reply(answer, mention_author=False)

    except Exception as e:
        logger.error("Erreur réponse message: %s", e)
        await message.reply(BOT_ERROR_MESSAGE, mention_author=False)


# ======================================================
# COMMANDES ADMIN TEXTE
# ======================================================

@bot.command(name="dire")
async def dire(ctx: commands.Context, salon: discord.TextChannel, *, message: str):
    """
    Utilisation :
    !dire #general ton message ici
    """

    if ADMIN_CHANNEL_ID and ctx.channel.id != ADMIN_CHANNEL_ID:
        await ctx.reply("Cette commande doit être utilisée dans le salon admin.", mention_author=False)
        return

    if not is_admin_user(ctx.author):
        await ctx.reply("Tu n’as pas les droits pour utiliser cette commande.", mention_author=False)
        return

    try:
        weather_context = await get_weather_context()

        prompt = f"""
Tu es {BOT_NAME}, un bot Discord dans une conversation entre collègues.

Mission :
L'utilisateur admin veut que tu envoies un message dans un salon Discord.
Tu dois reprendre son idée, la rendre plus naturelle, plus drôle et plus humaine.

Style demandé :
- français naturel
- humour de collègue
- un peu taquin
- jamais méchant
- pas humiliant
- pas de sujet sensible
- pas de gros pavé
- adapté à Discord
- tu peux intégrer la météo si ça colle naturellement

Contexte météo :
{weather_context}

Message brut demandé par l'admin :
{message}

Réécris uniquement le message final à envoyer.
Ne mets pas de guillemets.
Ne dis pas que tu es une IA.
""".strip()

        ai_messages = [
            {
                "role": "system",
                "content": "Tu reformules des messages Discord avec un ton humain, drôle et bienveillant."
            },
            {
                "role": "user",
                "content": prompt
            }
        ]

        final_message = await ask_openrouter(ai_messages)

        if len(final_message) > 1900:
            final_message = final_message[:1900] + "..."

        await salon.send(final_message)

        await ctx.reply(
            f"Message envoyé dans {salon.mention} :\n```txt\n{final_message}\n```",
            mention_author=False
        )

    except Exception as e:
        logger.error("Erreur commande !dire: %s", e)
        await ctx.reply(BOT_ERROR_MESSAGE, mention_author=False)


@bot.command(name="collegue")
async def collegue(
    ctx: commands.Context,
    membre: discord.Member,
    prenom: str = "",
    voiture: str = "",
    ville: str = "",
    *,
    notes: str = ""
):
    """
    Utilisation :
    !collegue @Jean Jean "Clio rouge" "vers Redon" adore le café et râle sur les imprimantes
    """

    if not is_admin_user(ctx.author):
        await ctx.reply("Tu n’as pas les droits pour utiliser cette commande.", mention_author=False)
        return

    upsert_colleague(
        discord_id=str(membre.id),
        display_name=membre.display_name,
        first_name=prenom,
        car=voiture,
        approximate_location=ville,
        workplace=WORKPLACE,
        humor_style="humour gentil et taquin",
        notes=notes
    )

    await ctx.reply(f"Contexte enregistré pour {membre.display_name}.", mention_author=False)


@bot.command(name="anecdote")
async def anecdote(ctx: commands.Context, membre: discord.Member, *, texte: str):
    """
    Utilisation :
    !anecdote @Jean Il arrive toujours avec un café à la main
    """

    if not is_admin_user(ctx.author):
        await ctx.reply("Tu n’as pas les droits pour utiliser cette commande.", mention_author=False)
        return

    colleague = get_colleague_by_discord_id(str(membre.id))

    if not colleague:
        upsert_colleague(
            discord_id=str(membre.id),
            display_name=membre.display_name,
            workplace=WORKPLACE,
            humor_style="humour gentil et taquin"
        )
        colleague = get_colleague_by_discord_id(str(membre.id))

    add_memory_for_colleague(colleague["id"], texte)

    await ctx.reply(f"Anecdote ajoutée pour {membre.display_name}.", mention_author=False)


@bot.command(name="voir")
async def voir(ctx: commands.Context, membre: discord.Member):
    """
    Utilisation :
    !voir @Jean
    """

    if not is_admin_user(ctx.author):
        await ctx.reply("Tu n’as pas les droits pour utiliser cette commande.", mention_author=False)
        return

    colleague = get_colleague_by_discord_id(str(membre.id))

    if not colleague:
        await ctx.reply("Je n’ai pas encore de contexte pour cette personne.", mention_author=False)
        return

    context = format_colleague_context(colleague)

    if len(context) > 1900:
        context = context[:1900] + "..."

    await ctx.reply(f"```txt\n{context}\n```", mention_author=False)


@bot.command(name="liste")
async def liste(ctx: commands.Context):
    """
    Utilisation :
    !liste
    """

    if not is_admin_user(ctx.author):
        await ctx.reply("Tu n’as pas les droits pour utiliser cette commande.", mention_author=False)
        return

    colleagues = list_colleagues()

    if not colleagues:
        await ctx.reply("Aucun collègue enregistré pour le moment.", mention_author=False)
        return

    lines = []

    for c in colleagues:
        first_name = c["first_name"] or "sans prénom"
        lines.append(f"- {c['display_name']} - {first_name}")

    text = "\n".join(lines)

    if len(text) > 1900:
        text = text[:1900] + "..."

    await ctx.reply(text, mention_author=False)


@bot.command(name="souvenir")
async def souvenir(ctx: commands.Context, *, texte: str):
    """
    Utilisation :
    !souvenir Le vendredi, tout le monde pense déjà au week-end
    """

    if not is_admin_user(ctx.author):
        await ctx.reply("Tu n’as pas les droits pour utiliser cette commande.", mention_author=False)
        return

    add_bot_memory(texte)

    await ctx.reply("Souvenir général ajouté.", mention_author=False)


@bot.command(name="meteo")
async def meteo(ctx: commands.Context):
    """
    Utilisation :
    !meteo
    """

    weather_context = await get_weather_context()
    await ctx.reply(weather_context, mention_author=False)


@bot.command(name="ping")
async def ping(ctx: commands.Context):
    """
    Utilisation :
    !ping
    """

    await ctx.reply(f"{BOT_NAME} est connecté. Les bêtises sont opérationnelles.", mention_author=False)


@bot.command(name="aidebot")
async def aidebot(ctx: commands.Context):
    """
    Utilisation :
    !aidebot
    """

    text = f"""
Commandes disponibles :

!ping
Vérifie si le bot est connecté.

!meteo
Affiche la météo actuelle.

!dire #salon message
Le bot reformule avec l’IA puis envoie le message dans le salon choisi.
Exemple :
!dire #general Bon courage pour la journée

!collegue @membre prénom voiture ville notes
Ajoute ou met à jour le contexte d’un collègue.
Exemple :
!collegue @Jean Jean "Clio rouge" "vers Redon" adore le café et râle sur les imprimantes

!anecdote @membre texte
Ajoute une anecdote.
Exemple :
!anecdote @Jean Il arrive toujours avec son café.

!voir @membre
Affiche le contexte connu d’un collègue.

!liste
Liste les collègues enregistrés.

!souvenir texte
Ajoute un souvenir général au bot.
Exemple :
!souvenir Le vendredi, tout le monde pense déjà au week-end.

Pour discuter avec moi :
Mentionne {BOT_NAME} ou réponds à un de mes messages.
""".strip()

    if len(text) > 1900:
        text = text[:1900] + "..."

    await ctx.reply(f"```txt\n{text}\n```", mention_author=False)


# ======================================================
# LANCEMENT
# ======================================================

bot.run(DISCORD_TOKEN)