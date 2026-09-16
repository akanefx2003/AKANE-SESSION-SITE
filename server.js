// server.js
// Génère une session WhatsApp (via code de pairing Baileys), envoie l'ID de
// session en message WhatsApp une fois connecté, puis fournit un config prêt
// à coller pour AKANE MD v1 ou v2 à partir de cet ID.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
// @itsliaaa/baileys (et non le paquet 'baileys' standard) : c'est ce fork qui
// sait construire un vrai nativeFlowMessage à partir du raccourci
// `interactiveButtons` utilisé plus bas. Avec le paquet 'baileys' de base,
// cette propriété est silencieusement ignorée — le message part quand même,
// mais sans bouton : c'est ce qui expliquait l'absence du native flow.
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from '@itsliaaa/baileys';
import fs from 'fs';
import crypto from 'crypto';

// Récupérée une seule fois au démarrage du serveur et réutilisée pour toutes
// les sessions — c'est ce qui manquait avant. Sans version explicite,
// Baileys peut se connecter avec une version de protocole périmée : la
// connexion réussit en apparence, mais WhatsApp rejette ensuite l'envoi de
// messages en silence (aucune exception côté Node), ce qui donnait
// exactement le symptôme "connecté mais jamais de message".
let cachedWAVersion = null;
async function getWAVersion() {
    if (cachedWAVersion) return cachedWAVersion;
    try {
        const { version } = await fetchLatestBaileysVersion();
        cachedWAVersion = version;
        console.log('📱 Version Baileys/WhatsApp utilisée :', version.join('.'));
    } catch (e) {
        console.error('⚠️ Impossible de récupérer la dernière version WA, on utilise celle par défaut de Baileys.');
    }
    return cachedWAVersion;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Filet de sécurité : si express.static ne sert pas index.html pour une
// raison quelconque (dossier public/ absent du déploiement, chemin
// différent...), cette route explicite donne un message clair au lieu du
// générique "Cannot GET /" d'Express.
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    res.status(500).send('index.html introuvable dans public/ — vérifie que ce dossier a bien été déployé (git add public/).');
});

// Compteur de sessions WhatsApp générées avec succès (pairing réussi),
// réinitialisé à chaque redémarrage du serveur (pas de base de données ici).
// Limite importante : ce serveur ne voit QUE la génération de la session, pas
// ce qui se passe ensuite. Il ne peut pas savoir si la personne a réellement
// déployé cette session sur un bot (v1/v2) qui tourne quelque part — ça se
// passe sur un tout autre serveur (Katabump, Bot-Hosting, Téo Héberg...) sans
// lien avec celui-ci. "Sessions connectées" ici veut donc dire "connectées à
// WhatsApp pendant la génération", pas "bot actif avec cette session".
let connectedCount = 0;
app.get('/api/stats', (req, res) => {
    res.json({ connected: connectedCount });
});

const TMP_DIR = path.join(__dirname, 'tmp-sessions');
fs.mkdirSync(TMP_DIR, { recursive: true });

// Stockage PERSISTANT des vraies creds (contrairement à TMP_DIR, jamais nettoyé
// automatiquement). C'est ce qui remplace l'encodage base64 direct dans le
// texte du "SESSION_ID" : le bot ira chercher les creds ici via HTTP au
// démarrage, à partir du petit identifiant. Ce serveur doit donc rester en
// ligne en continu — s'il tombe, aucun bot déjà déployé ne pourra relire sa
// session au prochain redémarrage.
const SESS_DIR = path.join(__dirname, 'stored-sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });

const CHANNEL_LINK = 'https://whatsapp.com/channel/0029Vb865EJ0QeapgV7MkP2D';

// sessions en cours de génération : id -> { status, code, sessionId, error, sock }
const sessions = new Map();

function cleanNumber(raw) {
    return String(raw || '').replace(/[^0-9]/g, '');
}

// L'ID de session peut faire plusieurs milliers de caractères sur une seule
// ligne logique. Selon l'app/le client utilisé pour copier le message
// WhatsApp, un saut de ligne, une espace insécable ou un retour chariot peut
// s'être glissé dedans pendant le copier-coller — ça casse le base64 au
// décodage ("session corrompue") sans que ce soit visible à l'œil. On
// nettoie systématiquement avant toute validation/usage.
function sanitizeSessionId(raw) {
    return String(raw || '').replace(/\s+/g, '');
}

// ── Démarre une tentative de pairing pour un numéro donné ───────────────────
app.post('/api/session/start', async (req, res) => {
    const number = cleanNumber(req.body.number);
    if (number.length < 7) {
        return res.status(400).json({ error: 'Numéro invalide (indicatif inclus, sans le +).' });
    }

    const id = `${number}-${Date.now()}`;
    const authDir = path.join(TMP_DIR, id);
    fs.mkdirSync(authDir, { recursive: true });

    sessions.set(id, { status: 'starting', code: null, sessionId: null, error: null });

    const CONFIRMATION_PHOTO = 'https://cdn.crysnovax.link/files/1789529127616-33458227-ca62-405d-8210-8c6047a33d03.jpg';

    // Même cadre stylé que celui utilisé partout ailleurs (plugins WhatsApp,
    // bot Telegram) — box(...) prend des lignes déjà préfixées par "│ *...*"
    // ou "│" pour une ligne vide.
    const BOX_TOP    = '╭┄─̣✦┄─̣✦┄─̣✦┄─̣✦';
    const BOX_TITLE  = '│ ⊹ *ɑׁׁׅׅƙׁׁׅׅɑׁׁׅׅ݊ꪀׁׅꫀׁׁׅܻׅ݊ ꩇׁׅ֪݊ ׁׅժׁׁׅׅ v²* ⊹';
    const BOX_SEP    = '│┄─̣┄─̣┄─̣┄─̣┄─̣';
    const BOX_BOTTOM = '╰┄─̣✦┄─̣✦┄─̣✦┄─̣✦';
    const BOX_FOOTER = '*© AKANE MD v2 🌹*';
    const box = (...lines) => [BOX_TOP, BOX_TITLE, BOX_SEP, ...lines, BOX_BOTTOM, BOX_FOOTER].join('\n');

    const CONFIRMATION_MESSAGE = box(
        `│ *✅ SESSION GÉNÉRÉE*`, `│`,
        `│ *Ton ID de session arrive dans le*`,
        `│ *message juste après celui-ci —*`,
        `│ *retourne sur le site et colle-le.*`, `│`,
        `│ *🔗 LIENS UTILES*`, `│`,
        `│ *YouTube :* https://youtube.com/@akanefx-j3k9o?si=cPol4CQyEg0Ei2rJ`,
        `│ *GitHub :* https://github.com/akanefx2003`,
        `│ *Groupe support :* https://chat.whatsapp.com/F9yJB6Xnbks55gS6URvdX2`,
        `│ *Chaîne WhatsApp :* https://whatsapp.com/channel/0029Vb865EJ0QeapgV7MkP2D`,
        `│ *Canal Telegram :* https://t.me/akane_md`
    );

    // (CHANNEL_LINK est désormais défini au niveau du module, en haut du fichier)

    // Fonction récursive : après le code de pairing, WhatsApp ferme souvent la
    // connexion avec le code "restartRequired" (515) — ce n'est PAS une erreur,
    // c'est une étape normale du flow qui attend une seconde connexion
    // immédiate avec le même état d'authentification pour finaliser le
    // pairing. Sans ce rappel, le téléphone reste bloqué sur "Connexion..."
    // indéfiniment, ce qui était le bug précédent.
    async function connectSocket(isReconnect = false) {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const version = await getWAVersion();
        const sock = makeWASocket({
            ...(version ? { version } : {}),
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 10000,
            connectTimeoutMs: 60000,
            // Requis pour que certains messages (dont les boutons interactifs)
            // soient acceptés par WhatsApp au lieu d'être silencieusement
            // ignorés — repris tel quel du bot qui fonctionne.
            getMessage: async () => ({ conversation: '' }),
            patchMessageBeforeSending: (msg) => {
                const requiresPatch = !!(msg.buttonsMessage || msg.listMessage || msg.templateMessage || msg.interactiveMessage);
                if (requiresPatch) {
                    msg = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} },
                                ...msg
                            }
                        }
                    };
                }
                return msg;
            }
        });

        const entry = sessions.get(id);
        if (!entry) return;
        entry.sock = sock;
        sock.ev.on('creds.update', saveCreds);

        if (!isReconnect && !state.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(number, 'AKANEMD9');
                    const e = sessions.get(id);
                    if (e) { e.code = code; e.status = 'code_ready'; }
                } catch (err) {
                    const e = sessions.get(id);
                    if (e) { e.status = 'error'; e.error = 'Impossible de générer le code : ' + err.message; }
                }
            }, 1500);
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            const current = sessions.get(id);
            if (!current) return;

            // Log serveur détaillé pour diagnostiquer si "aucun message" revient
            // encore — regarde ces logs après un essai pour voir où ça coince
            // réellement (jamais "open" ? boucle "restartRequired" en continu ?).
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`[session ${id}] connection=${connection}${statusCode ? ' statusCode=' + statusCode : ''}${isReconnect ? ' (reco)' : ''}`);

            if (connection === 'open') {
                try {
                    // Au lieu d'encoder tout l'objet creds en base64 dans le
                    // texte (des milliers de caractères), on le stocke ici sur
                    // le serveur et on ne renvoie qu'un court identifiant. Le
                    // bot ira chercher les vraies creds via l'API au démarrage.
                    // ⚠️ Quiconque possède ce court ID peut se connecter à la
                    // place du propriétaire du numéro (comme un mot de passe) —
                    // ne jamais le partager publiquement.
                    const shortId = crypto.randomBytes(9).toString('hex'); // 18 caractères
                    fs.writeFileSync(
                        path.join(SESS_DIR, shortId + '.json'),
                        JSON.stringify(state.creds)
                    );
                    // On garde le numéro à côté : l'étape suivante (génération
                    // du script de déploiement) le récupère automatiquement,
                    // sans que l'utilisateur ait à le retaper.
                    fs.writeFileSync(
                        path.join(SESS_DIR, shortId + '.meta.json'),
                        JSON.stringify({ number, createdAt: Date.now() })
                    );
                    const sessionId = 'AKANE~' + shortId;
                    current.sessionId = sessionId;

                    // sock.user.id peut inclure un suffixe d'appareil (":12"
                    // etc.) qui fait que l'envoi réussit côté code (aucune
                    // exception) mais n'atterrit jamais dans la conversation
                    // "toi-même" côté WhatsApp. On construit le JID directement
                    // depuis le numéro, comme dans akanex.js.
                    const selfJid = `${number}@s.whatsapp.net`;

                    // 1) Message de bienvenue EN PREMIER : photo + cadre stylé
                    // + liens + vrai bouton natif WhatsApp vers la chaîne.
                    // Le texte l'annonce explicitement ("ton ID de session
                    // arrive dans le message juste après celui-ci") donc
                    // l'ordre d'envoi doit correspondre à ce qui est écrit.
                    try {
                        await sock.sendMessage(selfJid, {
                            image: { url: CONFIRMATION_PHOTO },
                            caption: CONFIRMATION_MESSAGE,
                            footer: 'AKANE MD',
                            interactiveButtons: [
                                {
                                    name: 'cta_url',
                                    buttonParamsJson: JSON.stringify({
                                        display_text: 'Voir la chaîne',
                                        url: CHANNEL_LINK,
                                        merchant_url: CHANNEL_LINK
                                    })
                                }
                            ]
                        });
                    } catch (btnErr) {
                        console.log(`[session ${id}] bouton natif non supporté (${btnErr.message}), envoi sans bouton`);
                        await sock.sendMessage(selfJid, {
                            image: { url: CONFIRMATION_PHOTO },
                            caption: CONFIRMATION_MESSAGE
                        });
                    }
                    console.log(`[session ${id}] message d'accueil envoyé`);

                    // On laisse le temps à l'accusé de réception de vraiment
                    // faire l'aller-retour avant d'enchaîner — un envoi
                    // immédiatement après l'autre sur une connexion toute
                    // fraîche (session Signal en cours d'établissement) peut
                    // faire perdre le second message en silence.
                    await new Promise((r) => setTimeout(r, 2000));

                    // 2) La session part ensuite, seule — texte simple, donc
                    // léger et sans dépendance à l'upload média.
                    await sock.sendMessage(selfJid, { text: sessionId });
                    console.log(`[session ${id}] message session envoyé`);

                    console.log(`[session ${id}] messages envoyés avec succès`);
                    current.status = 'connected';
                    connectedCount++;

                    // Délai large avant de fermer : sur une connexion toute
                    // fraîche, la livraison réelle (chiffrement Signal +
                    // upload média + accusés de réception) peut prendre bien
                    // plus longtemps que ce qu'il faut pour que sendMessage()
                    // résolve côté code. Fermer trop tôt = message "envoyé"
                    // sans exception mais jamais réellement livré.
                    setTimeout(() => {
                        // end() ferme juste la connexion locale, sans révoquer
                        // l'appareil lié — contrairement à logout(), qui
                        // invaliderait immédiatement la session qu'on vient de capturer.
                        sock.end(undefined);
                    }, 15000);
                } catch (e) {
                    console.error(`[session ${id}] échec envoi message :`, e);
                    current.status = 'error';
                    current.error = 'Connecté mais échec de l\'envoi du message : ' + e.message;
                }
                setTimeout(() => { try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {} }, 20000);
                return;
            }

            if (connection === 'close') {
                if (statusCode === DisconnectReason.restartRequired) {
                    current.debugCode = statusCode;
                    // Petit délai avant de rouvrir : laisse le temps à
                    // creds.update/saveCreds de finir d'écrire sur le disque
                    // avant qu'on relise l'état d'auth juste après — sans ça,
                    // la reconnexion peut repartir sur un état pas encore à
                    // jour et reboucler indéfiniment sur restartRequired sans
                    // jamais atteindre "open" (symptôme : ça tourne sur
                    // WhatsApp sans jamais aboutir).
                    setTimeout(() => connectSocket(true), 800);
                    return;
                }

                if (current.status !== 'connected') {
                    current.status = 'error';
                    current.debugCode = statusCode;
                    current.error = current.error
                        || `Connexion fermée avant la fin du pairing (code ${statusCode || 'inconnu'}). Réessaie.`;
                }
            }
        });
    }

    try {
        await connectSocket(false);
    } catch (e) {
        sessions.set(id, { status: 'error', error: e.message });
    }

    res.json({ id });
});

// ── Le frontend vient chercher ici le code puis l'état de connexion ─────────
app.get('/api/session/status/:id', (req, res) => {
    const entry = sessions.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Session inconnue ou expirée.' });
    res.json({
        status: entry.status,
        code: entry.code || null,
        error: entry.error || null,
        debugCode: entry.debugCode || null
        // sessionId n'est jamais renvoyé ici : il n'arrive que par message
        // WhatsApp, jamais par cette route, pour éviter qu'il fuite si
        // quelqu'un d'autre devine/partage cet id de suivi.
    });
});

// ── Le bot (v1/v2) vient chercher les vraies creds ici au démarrage, à partir
// du court identifiant collé dans SESSION_ID. Il faut adapter le code de
// démarrage du bot pour qu'il appelle cette route (voir le message associé).
app.get('/api/session/creds/:id', (req, res) => {
    const id = req.params.id;
    if (!/^[a-f0-9]{6,40}$/i.test(id)) {
        return res.status(400).json({ error: 'ID de session invalide.' });
    }
    const file = path.join(SESS_DIR, id + '.json');
    if (!fs.existsSync(file)) {
        return res.status(404).json({ error: 'Session introuvable ou expirée sur ce serveur.' });
    }
    try {
        res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch (e) {
        res.status(500).json({ error: 'Session corrompue.' });
    }
});

// ── Génère le config prêt à coller à partir de l'ID collé par l'utilisateur ─
app.post('/api/config/build', (req, res) => {
    // Nettoyage systématique : une session très longue peut arriver ici avec
    // des espaces/retours à la ligne accidentels glissés pendant le
    // copier-coller (voir sanitizeSessionId plus haut) — sans ça, une session
    // par ailleurs valide serait rejetée comme "corrompue".
    const sessionId = sanitizeSessionId(req.body.sessionId);
    const version = req.body.version;

    if (!sessionId || !sessionId.startsWith('AKANE~')) {
        return res.status(400).json({ error: 'ID de session invalide (doit commencer par "AKANE~").' });
    }
    // Le court identifiant doit correspondre à un fichier de creds réellement
    // stocké sur ce serveur (généré à l'étape précédente).
    const shortId = sessionId.slice('AKANE~'.length);
    if (!/^[a-f0-9]{6,40}$/i.test(shortId) || !fs.existsSync(path.join(SESS_DIR, shortId + '.json'))) {
        return res.status(400).json({ error: 'ID de session invalide ou introuvable sur ce serveur.' });
    }

    if (!['v1', 'v2'].includes(version)) {
        return res.status(400).json({ error: 'Version invalide.' });
    }

    // Le numéro a été enregistré automatiquement à la génération de la
    // session (étape précédente) — pas besoin de le redemander ici.
    let number = '';
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(SESS_DIR, shortId + '.meta.json'), 'utf-8'));
        number = meta.number || '';
    } catch (e) {
        // Pas grave : le script généré aura juste USER_NUMBER vide à remplir à la main.
    }

    const generatorUrl = `${req.protocol}://${req.get('host')}`;

    const config = version === 'v1'
        ? `# AKANE MD v1 — variables d'environnement\nSESSION_ID=${sessionId}\n`
        : `# AKANE MD v2 — variables d'environnement\nSESSION_ID=${sessionId}\n`;

    let indexJs;

    if (version === 'v1') {
        // Script de déploiement complet AKANE MD v1 : clone le repo, configure
        // le numéro, récupère la vraie session sur ce générateur, installe les
        // dépendances puis démarre le bot. À coller tel quel dans un fichier
        // index.js à la racine de l'hébergement, puis lancer `node index.js`.
        indexJs = `const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

const USER_NUMBER = "${number}";
const SESSION_ID = "${sessionId}";

// ⚠️ Doit rester en ligne : le bot va chercher la vraie session ici au démarrage.
const GENERATOR_URL = "${generatorUrl}";

const GITHUB_REPO = "https://github.com/akanefx2003/AKANE_MD.git";

const c = {
    reset:  "\\x1b[0m",
    pink:   "\\x1b[35m",
    green:  "\\x1b[32m",
    red:    "\\x1b[31m",
    cyan:   "\\x1b[36m",
    yellow: "\\x1b[33m",
    bold:   "\\x1b[1m",
}

const ok  = (m) => console.log(\`\${c.green}  ✔  \${m}\${c.reset}\`)
const err = (m) => console.log(\`\${c.red}  ✘  \${m}\${c.reset}\`)
const inf = (m) => console.log(\`\${c.cyan}  ◈  \${m}\${c.reset}\`)

function banner() {
    console.clear()
    console.log(\`\${c.pink}\${c.bold}\`)
    console.log(\`  ┌────────────────────────────────────┐\`)
    console.log(\`  │       🌸  AKANE MD DÉPLOIEMENT  🌸   │\`)
    console.log(\`  └────────────────────────────────────┘\`)
    console.log(\`\${c.reset}\`)
}

async function progress(label, fn) {
    const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
    let i = 0
    process.stdout.write(\`\\r\${c.yellow}  \${frames[0]}  \${label}...\${c.reset}\`)
    const timer = setInterval(() => {
        process.stdout.write(\`\\r\${c.yellow}  \${frames[i++ % frames.length]}  \${label}...\${c.reset}\`)
    }, 80)
    try {
        const result = await fn()
        clearInterval(timer)
        process.stdout.write(\`\\r\${c.green}  ✔  \${label}\${c.reset}\\n\`)
        return result
    } catch(e) {
        clearInterval(timer)
        process.stdout.write(\`\\r\${c.red}  ✘  \${label}\${c.reset}\\n\`)
        throw e
    }
}

function clean() {
    fs.readdirSync(__dirname).forEach(file => {
        if (file === "index.js") return
        try {
            const p = path.join(__dirname, file)
            fs.statSync(p).isDirectory()
                ? fs.rmSync(p, { recursive: true, force: true })
                : fs.unlinkSync(p)
        } catch(e) {}
    })
}

function setup() {
    ["sessions", "data", "temp", "database"].forEach(d => {
        fs.mkdirSync(path.join(__dirname, d), { recursive: true })
    })
    const cfg = path.join(__dirname, "data", "config.json")
    if (!fs.existsSync(cfg)) {
        fs.writeFileSync(cfg, JSON.stringify({
            prefix: ".",
            botName: "AKANE MD",
            owner: USER_NUMBER,
            reaction: "🌸",
            channelLink: "${CHANNEL_LINK_PLACEHOLDER}"
        }, null, 2))
    }
    const ax = path.join(__dirname, "AKANEX", "akanex.js")
    if (fs.existsSync(ax)) {
        fs.writeFileSync(ax,
            fs.readFileSync(ax, "utf8")
              .replace(/phoneNumber:\\s*['"]\\d+['"]/, \`phoneNumber: '\${USER_NUMBER}'\`)
        )
    }
}

// Récupère la vraie session sur ce générateur et l'écrit dans sessions/creds.json
async function saveSession() {
    if (!SESSION_ID || !SESSION_ID.startsWith("AKANE~")) {
        throw new Error("SESSION_ID invalide (doit commencer par 'AKANE~').")
    }
    const part = SESSION_ID.slice("AKANE~".length)
    const sessDir = path.join(__dirname, "sessions")
    fs.mkdirSync(sessDir, { recursive: true })

    let creds
    if (part.length > 40) {
        creds = JSON.parse(Buffer.from(part, "base64").toString("utf-8"))
    } else {
        const res = await fetch(\`\${GENERATOR_URL}/api/session/creds/\${part}\`)
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error("Session introuvable sur le générateur : " + (body.error || res.status))
        }
        creds = await res.json()
    }
    fs.writeFileSync(path.join(sessDir, "creds.json"), JSON.stringify(creds, null, 2))
}

function installDeps() {
    return new Promise((resolve, reject) => {
        const p = spawn("npm", ["install"], { stdio: "pipe", shell: true })
        p.on("close", code => code === 0 ? resolve() : reject(new Error("npm install failed")))
    })
}

async function startBot() {
    inf("Démarrage d'AKANE MD...")
    try {
        const { default: connect } = await import("./AKANEX/akanex.js")
        const { default: handler } = await import("./akane/akanes.js")
        await connect(handler)
    } catch(e) {
        err(\`Erreur: \${e.message}\`)
        setTimeout(startBot, 5000)
    }
}

async function main() {
    banner()
    inf(\`Numéro : \${USER_NUMBER}\\n\`)
    try {
        await progress("Nettoyage", async () => clean())
        await progress("Clonage GitHub", async () => execSync(\`git clone \${GITHUB_REPO} .\`, { stdio: "pipe" }))
        await progress("Configuration", async () => setup())
        await progress("Récupération de la session", () => saveSession())
        await progress("Installation des dépendances", () => installDeps())
        console.log(\`\\n\${c.pink}\${c.bold}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${c.reset}\`)
        ok("Déploiement terminé — lancement du bot...\\n")
        await startBot()
    } catch(e) {
        err(\`Déploiement échoué : \${e.message}\`)
        process.exit(1)
    }
}

main()
`.replace('${CHANNEL_LINK_PLACEHOLDER}', CHANNEL_LINK);
    } else {
        // Script de déploiement complet AKANE MD v2 : clone AKANE-MD-V2 dans un
        // sous-dossier "bot/" (le repo a son propre index.js à la racine, donc
        // on évite de cloner directement dans "." pour ne pas écraser CE
        // script), récupère la vraie session dans bot/sessions/main/creds.json
        // (là où useMultiFileAuthState va la lire), installe les dépendances
        // puis démarre le bot.
        indexJs = `const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");

const USER_NUMBER = "${number}";
const SESSION_ID = "${sessionId}";

// ⚠️ Doit rester en ligne : le bot va chercher la vraie session ici au démarrage.
const GENERATOR_URL = "${generatorUrl}";

const GITHUB_REPO = "https://github.com/akanefx2003/AKANE-MD-V2.git";
const BOT_DIR = path.join(__dirname, "bot"); // sous-dossier : évite d'écraser CE script (aussi nommé index.js)

const c = {
    reset:  "\\x1b[0m",
    pink:   "\\x1b[35m",
    green:  "\\x1b[32m",
    red:    "\\x1b[31m",
    cyan:   "\\x1b[36m",
    yellow: "\\x1b[33m",
    bold:   "\\x1b[1m",
}

const ok  = (m) => console.log(\`\${c.green}  ✔  \${m}\${c.reset}\`)
const err = (m) => console.log(\`\${c.red}  ✘  \${m}\${c.reset}\`)
const inf = (m) => console.log(\`\${c.cyan}  ◈  \${m}\${c.reset}\`)

function banner() {
    console.clear()
    console.log(\`\${c.pink}\${c.bold}\`)
    console.log(\`  ┌────────────────────────────────────┐\`)
    console.log(\`  │     🌸  AKANE MD v2 DÉPLOIEMENT  🌸  │\`)
    console.log(\`  └────────────────────────────────────┘\`)
    console.log(\`\${c.reset}\`)
}

async function progress(label, fn) {
    const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
    let i = 0
    process.stdout.write(\`\\r\${c.yellow}  \${frames[0]}  \${label}...\${c.reset}\`)
    const timer = setInterval(() => {
        process.stdout.write(\`\\r\${c.yellow}  \${frames[i++ % frames.length]}  \${label}...\${c.reset}\`)
    }, 80)
    try {
        const result = await fn()
        clearInterval(timer)
        process.stdout.write(\`\\r\${c.green}  ✔  \${label}\${c.reset}\\n\`)
        return result
    } catch(e) {
        clearInterval(timer)
        process.stdout.write(\`\\r\${c.red}  ✘  \${label}\${c.reset}\\n\`)
        throw e
    }
}

function clean() {
    fs.readdirSync(__dirname).forEach(file => {
        if (file === "index.js") return
        try {
            const p = path.join(__dirname, file)
            fs.statSync(p).isDirectory()
                ? fs.rmSync(p, { recursive: true, force: true })
                : fs.unlinkSync(p)
        } catch(e) {}
    })
}

function cloneRepo() {
    fs.rmSync(BOT_DIR, { recursive: true, force: true })
    execSync(\`git clone \${GITHUB_REPO} "\${BOT_DIR}"\`, { stdio: "pipe" })
}

async function saveSession() {
    if (!SESSION_ID || !SESSION_ID.startsWith("AKANE~")) {
        throw new Error("SESSION_ID invalide (doit commencer par 'AKANE~').")
    }
    const part = SESSION_ID.slice("AKANE~".length)
    const sessDir = path.join(BOT_DIR, "sessions", "main")
    fs.mkdirSync(sessDir, { recursive: true })

    let creds
    if (part.length > 40) {
        creds = JSON.parse(Buffer.from(part, "base64").toString("utf-8"))
    } else {
        const res = await fetch(\`\${GENERATOR_URL}/api/session/creds/\${part}\`)
        if (!res.ok) {
            const body = await res.json().catch(() => ({}))
            throw new Error("Session introuvable sur le générateur : " + (body.error || res.status))
        }
        creds = await res.json()
    }
    fs.writeFileSync(path.join(sessDir, "creds.json"), JSON.stringify(creds, null, 2))
}

function setupConfig() {
    const dbDir = path.join(BOT_DIR, "database")
    fs.mkdirSync(dbDir, { recursive: true })
    const cfgPath = path.join(dbDir, "config.json")
    if (!fs.existsSync(cfgPath)) {
        fs.writeFileSync(cfgPath, JSON.stringify({
            prefix: ".",
            publicMode: false,
            sudoList: [],
            reaction: "🌹",
            owner: USER_NUMBER
        }, null, 2))
    }
}

function installDeps() {
    return new Promise((resolve, reject) => {
        const p = spawn("npm", ["install"], { cwd: BOT_DIR, stdio: "pipe", shell: true })
        p.on("close", code => code === 0 ? resolve() : reject(new Error("npm install failed")))
    })
}

async function startBot() {
    inf("Démarrage d'AKANE MD v2...")
    process.env.OWNER_NUMBER = USER_NUMBER
    try {
        await import(require("url").pathToFileURL(path.join(BOT_DIR, "index.js")).href)
    } catch(e) {
        err(\`Erreur: \${e.message}\`)
        setTimeout(startBot, 5000)
    }
}

async function main() {
    banner()
    inf(\`Numéro : \${USER_NUMBER}\\n\`)
    try {
        await progress("Nettoyage", async () => clean())
        await progress("Clonage GitHub", async () => cloneRepo())
        await progress("Configuration", async () => setupConfig())
        await progress("Récupération de la session", () => saveSession())
        await progress("Installation des dépendances", () => installDeps())
        console.log(\`\\n\${c.pink}\${c.bold}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${c.reset}\`)
        ok("Déploiement terminé — lancement du bot...\\n")
        await startBot()
    } catch(e) {
        err(\`Déploiement échoué : \${e.message}\`)
        process.exit(1)
    }
}

main()
`;
    }

    res.json({ config, indexJs, number });
});

// Pterodactyl (ton panel) fournit souvent le port via SERVER_PORT plutôt que
// PORT — on accepte les deux pour être sûr de se lier sur le bon port,
// celui vers lequel le panel route réellement le trafic externe.
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;
app.listen(PORT, () => console.log(`🌸 Générateur de session AKANE MD -> http://localhost:${PORT}`));
