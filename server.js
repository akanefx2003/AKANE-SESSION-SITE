// server.js
// Génère une session WhatsApp (via code de pairing Baileys), envoie l'ID de
// session en message WhatsApp une fois connecté, puis fournit un config prêt
// à coller pour AKANE MD v1 ou v2 à partir de cet ID.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
// Paquet standard 'baileys' (pas de fork tiers). L'ancien fork @itsliaaa/baileys
// permettait un vrai bouton natif (nativeFlowMessage) sur le message de
// confirmation, mais provoquait des échecs de pairing ("impossible de se
// connecter" au moment d'entrer le code) — probablement plus à jour avec le
// protocole WhatsApp actuel. Avec le paquet standard, `interactiveButtons`
// plus bas est silencieusement ignoré : le message part quand même, juste
// sans bouton.
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from 'baileys';
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

// Sur Render (et la plupart des PaaS gratuits), le disque est ÉPHÉMÈRE : tout
// fichier écrit ici est perdu au prochain redéploiement/redémarrage — y
// compris les vraies sessions stockées dans SESS_DIR. Si tu déploies sur
// Render, attache un "Disk" persistant (payant) monté sur un chemin fixe
// (ex: /data) et mets DATA_DIR=/data dans les variables d'environnement.
// Sans ça, les bots déjà déployés perdront leur session au moindre redéploiement.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
if (!process.env.DATA_DIR) {
    console.warn('⚠️  DATA_DIR non défini : les sessions seront perdues au prochain redéploiement (disque éphémère sur Render/Heroku). Voir le commentaire ci-dessus.');
}

const TMP_DIR = path.join(DATA_DIR, 'tmp-sessions');
fs.mkdirSync(TMP_DIR, { recursive: true });

// Stockage PERSISTANT des vraies creds (contrairement à TMP_DIR, jamais nettoyé
// automatiquement). C'est ce qui remplace l'encodage base64 direct dans le
// texte du "SESSION_ID" : le bot ira chercher les creds ici via HTTP au
// démarrage, à partir du petit identifiant. Ce serveur doit donc rester en
// ligne en continu — s'il tombe, aucun bot déjà déployé ne pourra relire sa
// session au prochain redémarrage.
const SESS_DIR = path.join(DATA_DIR, 'stored-sessions');
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

    // Token opaque et aléatoire plutôt que "numéro-timestamp" (devinable) :
    // ça permet de renvoyer sessionId directement via ce même id une fois
    // connecté, sans risquer qu'un tiers le devine.
    const id = crypto.randomBytes(12).toString('hex');
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
        `│ *Ton ID de session est déjà affiché*`,
        `│ *sur le site — ce message est juste*`,
        `│ *une copie de secours.*`, `│`,
        `│ *💰 JE DÉPLOIE POUR TOI*`, `│`,
        `│ *Déploiement simple — 1500F*`,
        `│ *1 mois sans déconnexion, v1 ou v2*`, `│`,
        `│ *Pack Premium — 2500F*`,
        `│ *1 mois, v1+v2, tous les plugins*`, `│`,
        `│ *Commander : wa.me/221705928204*`, `│`,
        `│ *🏠 HÉBERGEMENT RECOMMANDÉ*`, `│`,
        `│ *Téo Héberg (panel gratuit) :*`,
        `│ *manager.teoheberg.fr/register?ref=4CKPZaU1*`, `│`,
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
        debugCode: entry.debugCode || null,
        // Sûr à renvoyer maintenant : l'id de suivi est un token aléatoire
        // opaque (voir /api/session/start), pas "numéro-timestamp" devinable.
        // Le message WhatsApp reste envoyé en backup, mais l'utilisateur n'a
        // plus besoin de quitter le site pour récupérer sa session.
        sessionId: entry.status === 'connected' ? entry.sessionId : null
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
  try {
    // Nettoyage systéma
