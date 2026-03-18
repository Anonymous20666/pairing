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

// --- SETTINGS ---
const BOT_TOKEN = '8647913571:AAFHuWDgb4-V7sIn5JigPIQSr7r5x_0iIUI';
const PORT = process.env.PORT || 3000;

// Keep-alive server for Render/Replit
http.createServer((req, res) => res.end("Bot is Live")).listen(PORT);

const bot = new Telegraf(BOT_TOKEN);

// Main Menu
const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Start Pairing', 'start_pair')],
    [Markup.button.callback('🛠 Help', 'help_info')]
]);

bot.start((ctx) => {
    ctx.replyWithMarkdown(
        `👋 *Welcome Pappy!*\n\nThis bot generates WhatsApp session files (creds.json) for your bots. \n\nClick the button below to begin.`,
        mainMenu
    );
});

bot.action('start_pair', (ctx) => {
    ctx.reply("📱 *Send your phone number with country code.*\n\nExample: `2348100000000`", { parse_mode: 'Markdown' });
});

bot.action('help_info', (ctx) => {
    ctx.reply("Simply send your number, wait for the code, and enter it in WhatsApp's 'Linked Devices' section.");
});

bot.on('text', async (ctx) => {
    const number = ctx.message.text.trim();
    if (!/^\d{10,15}$/.test(number)) {
        return ctx.reply("❌ Invalid number. Please send only digits with country code.");
    }

    await ctx.reply("⏳ *Establishing secure connection...*", { parse_mode: 'Markdown' });
    
    // Unique session ID for every single request to allow multiple pairings
    const uniqueSessionID = `session_${ctx.from.id}_${Date.now()}`;
    startSessionProcess(ctx, number, uniqueSessionID);
});

async function startSessionProcess(ctx, phoneNumber, sessionID) {
    const sessionDir = path.join(__dirname, 'temp_sessions', sessionID);
    await fs.ensureDir(sessionDir);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
        },
        logger: pino({ level: 'fatal' }),
        printQRInTerminal: false,
        // Realistic browser to prevent "Something went wrong"
        browser: ["Ubuntu", "Chrome", "121.0.6167.160"] 
    });

    // Request Pairing Code
    if (!sock.authState.creds.registered) {
        await delay(3500); // Wait for socket to ready
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            await ctx.replyWithMarkdown(
                `🔑 *Your Pairing Code:*\n\n\`${code}\`\n\n*Instructions:*\n1. Open WhatsApp Settings\n2. Tap Linked Devices\n3. Tap 'Link with phone number'\n4. Enter the code above.`
            );
        } catch (e) {
            console.error(e);
            return ctx.reply("❌ Failed to get pairing code. Please wait 2 minutes and try again.");
        }
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            await ctx.reply("🎊 *Login Successful!* \nPackaging your session file...");
            
            const credsPath = path.join(sessionDir, 'creds.json');
            
            if (fs.existsSync(credsPath)) {
                // Send the file to user
                await ctx.replyWithDocument({ source: credsPath, filename: 'creds.json' }, {
                    caption: "🚀 *Session Generated Successfully!*\n\nThis file is now linked as a device. You can forward this to your deployment manager."
                });
            }

            // DO NOT log out. Just stop the local socket instance.
            // This allows the session to stay valid on the user's phone.
            sock.end(); 
            // We keep the file in temp_sessions for a few minutes then delete
            setTimeout(() => fs.remove(sessionDir), 60000);
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === 401) {
                ctx.reply("❌ Session invalidated by WhatsApp. Please try again.");
            }
        }
    });
}

bot.launch().then(() => console.log(">>> Session Generator Bot Online"));
