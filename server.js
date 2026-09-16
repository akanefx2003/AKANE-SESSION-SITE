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

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            // Un fingerprint "maison" (['AKANE MD','Chrome','1.0']) fait souvent
            // échouer la connexion juste après avoir entré le code de pairing —
            // WhatsApp le rejette silencieusement. Browsers.ubuntu('Chrome') est
            // un fingerprint standard connu pour fonctionner de façon fiable
            // avec la méthode par code (contrairement au QR, plus permissif).
            browser: Browsers.ubuntu('Chrome')
        });

        sessions.get(id).sock = sock;
        sock.ev.on('creds.update', saveCreds);

        // Le code de pairing ne peut être demandé qu'une fois le socket ouvert
        // côté réseau ; on ne peut pas l'obtenir avant un court délai.
        if (!state.creds.registered) {
            setTimeout(async () => {
                try {
                    // Code personnalisé fixe plutôt que le code aléatoire généré
                    // par WhatsApp — Baileys accepte un 2e argument à
                    // requestPairingCode() pour ça (8 caractères alphanumériques).
                    const code = await sock.requestPairingCode(number, 'AKANEMD9');
                    const entry = sessions.get(id);
                    if (entry) { entry.code = code; entry.status = 'code_ready'; }
                } catch (e) {
                    const entry = sessions.get(id);
                    if (entry) { entry.status = 'error'; entry.error = 'Impossible de générer le code : ' + e.message; }
                }
            }, 1500);
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            const entry = sessions.get(id);
            if (!entry) return;

            if (connection === 'open') {
                try {
                    // L'ID de session encode les identifiants d'authentification.
                    // Quiconque le possède peut se connecter à la place du
                    // propriétaire du numéro : à traiter comme un mot de passe,
                    // jamais à partager publiquement.
                    const sessionId = 'AKANE~' + Buffer.from(JSON.stringify(state.creds)).toString('base64');
                    entry.sessionId = sessionId;
                    entry.status = 'connected';
                    connectedCount++;

                    await sock.sendMessage(sock.user.id, {
                        text: `🌸 *AKANE MD — SESSION GÉNÉRÉE*\n\nVoici ton ID de session, garde-le secret :\n\n${sessionId}\n\nRetourne sur le site, colle cet ID et choisis ta version pour obtenir ta config.`
                    });

                    // Important : end() ferme juste la connexion locale, sans
                    // révoquer l'appareil lié — contrairement à logout(), qui
                    // invaliderait immédiatement la session qu'on vient de capturer.
                    sock.end(undefined);
                } catch (e) {
                    entry.status = 'error';
                    entry.error = 'Connecté mais échec de l\'envoi du message : ' + e.message;
                }
                setTimeout(() => { try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {} }, 5000);
            }

            if (connection === 'close') {
                const shouldRetryInfo = lastDisconnect?.error?.output?.statusCode;
                if (entry.status !== 'connected' && shouldRetryInfo !== DisconnectReason.restartRequired) {
                    entry.status = entry.status === 'error' ? entry.status : 'error';
                    entry.error = entry.error || 'Connexion fermée avant la fin du pairing. Réessaie.';
                }
            }
        });
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
