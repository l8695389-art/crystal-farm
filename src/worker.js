const MAX_ENERGY = 500;
const ENERGY_REGEN_MS = 2000; // 1 energy per 2s

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rowToPlayer(row) {
  return {
    id: row.id,
    nickname: row.nickname,
    username: row.username,
    avatarUrl: row.avatar_url,
    coins: row.coins,
    energy: row.energy,
    lastEnergyTs: row.last_energy_ts,
    streak: row.streak,
    lastCheckin: row.last_checkin,
    totalTaps: row.total_taps,
    dailyTaps: row.daily_taps,
    dailyTapsDate: row.daily_taps_date,
    claimedMissions: JSON.parse(row.claimed_missions || "[]"),
  };
}

// Applies offline energy regeneration before returning a player to the client.
function withRegen(player) {
  const elapsed = Date.now() - player.lastEnergyTs;
  const regen = Math.floor(elapsed / ENERGY_REGEN_MS);
  if (regen > 0) {
    player.energy = Math.min(MAX_ENERGY, player.energy + regen);
    player.lastEnergyTs = Date.now();
  }
  return player;
}

// Validates Telegram Mini App initData per Telegram's HMAC scheme.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function validateInitData(initData, botToken) {
  const encoder = new TextEncoder();
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return false;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKeyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const secretKeyBytes = await crypto.subtle.sign(
    "HMAC",
    secretKeyMaterial,
    encoder.encode(botToken)
  );
  const signingKey = await crypto.subtle.importKey(
    "raw",
    secretKeyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    encoder.encode(dataCheckString)
  );
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === hash;
}

// Gửi tin nhắn trả lời qua Telegram Bot API.
async function sendTelegramMessage(botToken, chatId, text, replyMarkup) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    }),
  });
  return res.json();
}

// Xử lý một Telegram Update. Hiện chỉ trả lời lệnh /start, có thể mở rộng
// thêm các lệnh khác (/help, /leaderboard...) tại đây.
async function handleTelegramUpdate(update, env) {
  const message = update.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start" || text.startsWith("/start ")) {
    const firstName = message.from?.first_name || "";
    const appUrl = env.MINI_APP_URL || "";

    const greeting = firstName
      ? `Chào ${escapeHtmlTg(firstName)}! 👋`
      : "Chào bạn! 👋";

    const body =
      `${greeting}\n\n` +
      `Chào mừng đến với <b>Đào Đá Quý</b> — chạm để đào xu, điểm danh nhận thưởng mỗi ngày, ` +
      `hoàn thành nhiệm vụ và leo bảng xếp hạng cùng bạn bè.\n\n` +
      `Bấm nút bên dưới để bắt đầu chơi 👇`;

    const replyMarkup = appUrl
      ? {
          inline_keyboard: [[{ text: "🎮 Chơi ngay", web_app: { url: appUrl } }]],
        }
      : undefined;

    await sendTelegramMessage(env.BOT_TOKEN, chatId, body, replyMarkup);
  }
}

function escapeHtmlTg(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/webhook" && request.method === "POST") {
        // Nếu có cấu hình WEBHOOK_SECRET, kiểm tra header bí mật Telegram gửi kèm
        // để chắc chắn request thực sự đến từ Telegram.
        if (env.WEBHOOK_SECRET) {
          const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
          if (secretHeader !== env.WEBHOOK_SECRET) {
            return json({ error: "unauthorized" }, 401);
          }
        }
        if (!env.BOT_TOKEN) return json({ error: "BOT_TOKEN not configured" }, 500);

        const update = await request.json();
        await handleTelegramUpdate(update, env);
        // Telegram chỉ cần HTTP 200, nội dung trả về không quan trọng.
        return json({ ok: true });
      }

      if (url.pathname === "/api/player" && request.method === "GET") {
        const id = url.searchParams.get("id");
        if (!id) return json({ error: "missing id" }, 400);
        const row = await env.DB.prepare("SELECT * FROM players WHERE id = ?")
          .bind(id)
          .first();
        if (!row) return json({ player: null });
        return json({ player: withRegen(rowToPlayer(row)) });
      }

      if (url.pathname === "/api/player" && request.method === "POST") {
        const body = await request.json();

        // If a bot token secret is configured, require and validate initData.
        if (env.BOT_TOKEN) {
          if (!body.initData) return json({ error: "missing initData" }, 401);
          const ok = await validateInitData(body.initData, env.BOT_TOKEN);
          if (!ok) return json({ error: "invalid initData" }, 401);
        }

        const p = body.player;
        if (!p || !p.id || !p.nickname) {
          return json({ error: "invalid payload" }, 400);
        }

        await env.DB.prepare(
          `INSERT INTO players
            (id, nickname, username, avatar_url, coins, energy, last_energy_ts, streak, last_checkin, total_taps, daily_taps, daily_taps_date, claimed_missions, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             nickname = excluded.nickname,
             username = excluded.username,
             avatar_url = excluded.avatar_url,
             coins = excluded.coins,
             energy = excluded.energy,
             last_energy_ts = excluded.last_energy_ts,
             streak = excluded.streak,
             last_checkin = excluded.last_checkin,
             total_taps = excluded.total_taps,
             daily_taps = excluded.daily_taps,
             daily_taps_date = excluded.daily_taps_date,
             claimed_missions = excluded.claimed_missions,
             updated_at = excluded.updated_at`
        )
          .bind(
            p.id,
            p.nickname,
            p.username || null,
            p.avatarUrl || null,
            p.coins,
            p.energy,
            p.lastEnergyTs,
            p.streak,
            p.lastCheckin,
            p.totalTaps,
            p.dailyTaps,
            p.dailyTapsDate,
            JSON.stringify(p.claimedMissions || []),
            Date.now()
          )
          .run();

        return json({ ok: true });
      }

      if (url.pathname === "/api/leaderboard" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          "SELECT nickname, avatar_url, coins FROM players ORDER BY coins DESC LIMIT 10"
        ).all();
        return json({ leaderboard: results });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
