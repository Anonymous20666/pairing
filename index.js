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

// ================= CONFIG =================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN not set");

const bot = new Telegraf(BOT_TOKEN);
const logger = pino({ level: 'silent' });

http.createServer((req, res) => res.end("🟢 Bot Alive"))
    .listen(process.env.PORT || 3000);

// =============== GLOBALS ==================
const activeUsers = new Map(); // queue system
const COOLDOWN = 60_000;

// =============== HELPERS ==================
const sleep = ms => new Promise(r => setTimeout(r, ms));
const validNum = n => /^\d{7,15}$/.test(n);

async function clean(dir) {
    try { await fs.remove(dir); } catch {}
}

// ============ PAIRING CORE ===============
async function runPairing(ctx, phone) {
    const userId = ctx.from.id;

    if (activeUsers.has(userId))
        return ctx.reply("⏳ You already have an active session.");

    activeUsers.set(userId, true);

    const sessionID = `sess_${userId}_${Date.now()}`;
    const dir = path.join(__dirname, 'auth', sessionID);
    await fs.ensureDir(dir);

    let retries = 0;
    const MAX_RETRIES = 3;

    async function attempt() {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(dir);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                printQRInTerminal: false,
                logger,
                browser: ["Ubuntu", "Chrome", "120.0.0.0"],
                connectTimeoutMs: 60_000,
                defaultQueryTimeoutMs: 0
            });

            if (!sock.authState.creds.registered) {
                await delay(4000);
                const code = await sock.requestPairingCode(phone);
                await ctx.reply(`🔐 *PAIR CODE:* \`${code}\`\n\nLink via WhatsApp Linked Devices.`,
                    { parse_mode: "Markdown" });
            }

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async ({ connection }) => {
                if (connection === 'open') {
                    const credsPath = path.join(dir, 'creds.json');

                    await ctx.reply("✅ *DEVICE LINKED*");
                    await ctx.replyWithDocument({
                        source: credsPath,
                        filename: 'creds.json'
                    });

                    sock.end();
                    setTimeout(() => clean(dir), 8000);
                    activeUsers.delete(userId);
                }
            });

        } catch (err) {
            retries++;
            if (retries < MAX_RETRIES) {
                await ctx.reply(`⚠️ Retry ${retries}/${MAX_RETRIES}...`);
                await sleep(3000);
                return attempt();
            } else {
                await ctx.reply("❌ Pairing failed. Try later.");
                activeUsers.delete(userId);
                await clean(dir);
            }
        }
    }

    await attempt();

    // auto-timeout
    setTimeout(() => {
        if (activeUsers.has(userId)) {
            activeUsers.delete(userId);
            clean(dir);
            ctx.reply("⌛ Session expired. Start again.");
        }
    }, 5 * 60_000);
}

// ============ TELEGRAM UI =================
bot.start((ctx) => {
    ctx.reply(
        "👋 *WhatsApp Pairing Bot*\n\nPress button to begin.",
        {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
                [Markup.button.callback("🚀 Start Pairing", "start_pair")]
            ])
        }
    );
});

bot.action("start_pair", (ctx) => {
    ctx.reply("📱 Send your WhatsApp number with country code.\nExample: 2348012345678");
});

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;

    // anti-spam cooldown
    if (ctx.message.date * 1000 < Date.now() - COOLDOWN === false)
        return;

    const num = ctx.message.text.trim();

    if (!validNum(num))
        return ctx.reply("❌ Invalid number format.");

    await ctx.reply("⏳ Connecting...");
    runPairing(ctx, num);
});

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bot.launch().then(() => console.log("✅ Bot Running"));
