// server.js
// Génère une session WhatsApp (via code de pairing Baileys), envoie l'ID de
// session en message WhatsApp une fois connecté, puis fournit un config prêt
// à coller pour AKANE MD v1 ou v2 à partir de cet ID.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from 'baileys';
import fs from 'fs';

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

// Compteur simple de sessions générées avec succès, réinitialisé à chaque
// redémarrage du serveur (pas de base de données ici).
let connectedCount = 0;
app.get('/api/stats', (req, res) => {
    res.json({ connected: connectedCount });
});

const TMP_DIR = path.join(__dirname, 'tmp-sessions');
fs.mkdirSync(TMP_DIR, { recursive: true });

// sessions en cours de génération : id -> { status, code, sessionId, error, sock }
const sessions = new Map();

function cleanNumber(raw) {
    return String(raw || '').replace(/[^0-9]/g, '');
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

    // Fonction récursive : après le code de pairing, WhatsApp ferme souvent la
    // connexion avec le code "restartRequired" (515) — ce n'est PAS une erreur,
    // c'est une étape normale du flow qui attend une seconde connexion
    // immédiate avec le même état d'authentification pour finaliser le
    // pairing. Sans ce rappel, le téléphone reste bloqué sur "Connexion..."
    // indéfiniment, ce qui était le bug précédent.
    async function connectSocket(isReconnect = false) {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome')
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

            if (connection === 'open') {
                try {
                    // L'ID de session encode les identifiants d'authentification.
                    // Quiconque le possède peut se connecter à la place du
                    // propriétaire du numéro : à traiter comme un mot de passe,
                    // jamais à partager publiquement.
                    const sessionId = 'AKANE~' + Buffer.from(JSON.stringify(state.creds)).toString('base64');
                    current.sessionId = sessionId;

                    // 1) Message de bienvenue avec photo + cadre stylé + liens.
                    await sock.sendMessage(sock.user.id, {
                        image: { url: CONFIRMATION_PHOTO },
                        caption: CONFIRMATION_MESSAGE
                    });

                    // 2) La session est envoyée À PART, seule, sans aucun texte
                    // autour — plus simple à sélectionner et copier en entier
                    // depuis WhatsApp sans accrocher un lien ou un emoji collé.
                    await sock.sendMessage(sock.user.id, { text: sessionId });

                    current.status = 'connected';
                    connectedCount++;

                    // On laisse un peu de temps au socket pour vraiment finir
                    // d'envoyer les messages sur le réseau avant de le fermer —
                    // fermer juste après sendMessage() peut couper l'envoi en
                    // cours et faire disparaître le message côté destinataire.
                    setTimeout(() => {
                        // end() ferme juste la connexion locale, sans révoquer
                        // l'appareil lié — contrairement à logout(), qui
                        // invaliderait immédiatement la session qu'on vient de capturer.
                        sock.end(undefined);
                    }, 2500);
                } catch (e) {
                    current.status = 'error';
                    current.error = 'Connecté mais échec de l\'envoi du message : ' + e.message;
                }
                setTimeout(() => { try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {} }, 8000);
                return;
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                if (statusCode === DisconnectReason.restartRequired) {
                    connectSocket(true); // reconnexion immédiate requise pour finaliser le pairing
                    return;
                }

                if (current.status !== 'connected') {
                    current.status = 'error';
                    current.error = current.error || 'Connexion fermée avant la fin du pairing. Réessaie.';
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
        error: entry.error || null
        // sessionId n'est jamais renvoyé ici : il n'arrive que par message
        // WhatsApp, jamais par cette route, pour éviter qu'il fuite si
        // quelqu'un d'autre devine/partage cet id de suivi.
    });
});

// ── Génère le config prêt à coller à partir de l'ID collé par l'utilisateur ─
app.post('/api/config/build', (req, res) => {
    const { sessionId, version } = req.body;

    if (!sessionId || !sessionId.startsWith('AKANE~')) {
        return res.status(400).json({ error: 'ID de session invalide (doit commencer par "AKANE~").' });
    }
    try {
        JSON.parse(Buffer.from(sessionId.slice('AKANE~'.length), 'base64').toString('utf-8'));
    } catch (e) {
        return res.status(400).json({ error: 'ID de session corrompu ou incomplet.' });
    }

    if (!['v1', 'v2'].includes(version)) {
        return res.status(400).json({ error: 'Version invalide.' });
    }

    // ⚠️ Les noms de variable ci-dessous sont une convention par défaut —
    // adapte-les si le code de démarrage de v1/v2 attend un autre nom
    // (regarde comment repos/v1 ou repos/v2 lisent la session au démarrage).
    const config = version === 'v1'
        ? `# AKANE MD v1 — variables d'environnement\nSESSION_ID=${sessionId}\n`
        : `# AKANE MD v2 — variables d'environnement\nSESSION_ID=${sessionId}\n`;

    res.json({ config });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🌸 Générateur de session AKANE MD -> http://localhost:${PORT}`));
