const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore 
} = require("gifted-baileys");
const { Telegraf, Markup } = require('telegraf');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const http = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN || '8647913571:AAFHuWDgb4-V7sIn5JigPIQSr7r5x_0iIUI';
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => res.end("Session Pro is Live")).listen(PORT);

const bot = new Telegraf(BOT_TOKEN);

async function startSessionProcess(ctx, phoneNumber, sessionID) {
    const sessionDir = path.join(__dirname, 'temp_sessions', sessionID);
    await fs.ensureDir(sessionDir);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`>>> Starting session for ${phoneNumber} using Baileys v${version}`);

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'error' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'error' }),
        // This specific browser string helps bypass Replit IP blocks
        browser: ["Chrome (Linux)", "Chrome", "121.0.6167.160"],
        connectTimeoutMs: 60000, // Wait up to 60 seconds
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
    });

    if (!sock.authState.creds.registered) {
        // Reduced delay for faster response
        await delay(2000); 
        try {
            console.log(`>>> Requesting code for ${phoneNumber}...`);
            const code = await sock.requestPairingCode(phoneNumber);
            await ctx.reply(`✅ *Pairing Code:* \`${code}\` \n\nEnter this in WhatsApp Settings > Linked Devices.`, { parse_mode: 'Markdown' });
        } catch (e) {
            console.error(">>> PAIRING ERROR:", e.message);
            return ctx.reply("❌ WhatsApp is busy or blocking the request. Please click 'Start Pairing' again.");
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            const credsPath = path.join(sessionDir, 'creds.json');
            await ctx.reply("🎊 *Success!* Sending your session file...");
            await ctx.replyWithDocument({ source: credsPath, filename: 'creds.json' });
            sock.end();
            setTimeout(() => fs.remove(sessionDir), 10000);
        }
        if (connection === 'close') {
            console.log(">>> Connection closed. Reason:", lastDisconnect?.error?.message);
        }
    });
}

bot.action('start_pair', (ctx) => {
    ctx.reply("📱 Send your phone number (e.g. 23481...)");
});

bot.on('text', async (ctx) => {
    const number = ctx.message.text.trim();
    if (!/^\d+$/.test(number)) return;
    
    await ctx.reply("⏳ *Connecting to WhatsApp Servers...*", { parse_mode: 'Markdown' });
    const sessionID = `pappy_${Date.now()}`;
    startSessionProcess(ctx, number, sessionID);
});

bot.launch();
