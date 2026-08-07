const MAX_ENERGY = 500;
const ENERGY_REGEN_MS = 2000; // 1 energy per 2s

// ── Cấp độ đào ──
const MINING_MAX_LEVEL = 20;
const MINING_BASE_XP = 500; // XP cần để lên cấp 2 (từ cấp 1)
const MINING_XP_STEP = 300; // mỗi cấp sau cộng thêm 300 XP so với cấp trước

// ── Đổi Gem ──
const GEM_EXCHANGE_RATE = 100000; // 100.000 coin = 1 gem

// ── Mời bạn bè ──
const REFERRAL_SIGNUP_BONUS = 1000; // coin cho người mời khi mời thành công 1 bạn mới
const REFERRAL_COMMISSION_RATE = 0.04; // hoa hồng 4% trên số coin người được mời kiếm thêm được
const REFERRAL_MILESTONES = [
  { count: 5, coin: 5000, gem: 5 },
  { count: 10, coin: 12000, gem: 12 },
  { count: 20, coin: 30000, gem: 30 },
  { count: 50, coin: 100000, gem: 100 },
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function xpNeededForLevel(level) {
  return MINING_BASE_XP + MINING_XP_STEP * (level - 1);
}

function rowToPlayer(row) {
  return {
    id: row.id,
    nickname: row.nickname,
    username: row.username,
    avatarUrl: row.avatar_url,
    coins: row.coins,
    gems: row.gems || 0,
    energy: row.energy,
    lastEnergyTs: row.last_energy_ts,
    streak: row.streak,
    lastCheckin: row.last_checkin,
    totalTaps: row.total_taps,
    dailyTaps: row.daily_taps,
    dailyTapsDate: row.daily_taps_date,
    claimedMissions: JSON.parse(row.claimed_missions || "[]"),
    miningLevel: row.mining_level || 1,
    miningXp: row.mining_xp || 0,
    referredBy: row.referred_by || null,
    referralCount: row.referral_count || 0,
    referralEarnings: row.referral_earnings || 0,
    claimedReferralMilestones: JSON.parse(row.claimed_referral_milestones || "[]"),
    referredUsers: JSON.parse(row.referred_users || "[]"),
    gemExchangeLog: JSON.parse(row.gem_exchange_log || "[]"),
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

// Validates Telegram Mini App initData per Telegram's HMAC scheme and
// returns the verified Telegram user embedded in it (or null if invalid).
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
async function verifyInitData(initData, botToken) {
  const encoder = new TextEncoder();
  const params = new URLSearchParams(initData || "");
  const hash = params.get("hash");
  if (!hash) return { ok: false, user: null };
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
  if (hex !== hash) return { ok: false, user: null };

  let user = null;
  const userRaw = params.get("user");
  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch {
      user = null;
    }
  }
  return { ok: true, user };
}

// Xác thực rằng request thực sự đến từ Telegram VÀ uid trong body khớp với
// uid đã ký trong initData — chặn trường hợp client tự sửa uid để giả mạo
// người chơi khác (đổi gem, nhận thưởng mốc mời bạn hộ người khác...).
// Trả về true nếu hợp lệ hoặc nếu chưa cấu hình BOT_TOKEN (chế độ dev).
async function assertOwnsUid(env, initData, uid) {
  if (!env.BOT_TOKEN) return true; // chưa cấu hình — bỏ qua (chế độ phát triển)
  const { ok, user } = await verifyInitData(initData, env.BOT_TOKEN);
  if (!ok || !user) return false;
  return String(user.id) === String(uid);
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

    const greeting = firstName ? `Chào ${escapeHtmlTg(firstName)}! 👋` : "Chào bạn! 👋";

    const body =
      `${greeting}\n\n` +
      `Chào mừng đến với <b>Đào Đá Quý</b> — chạm để đào xu, điểm danh nhận thưởng mỗi ngày, ` +
      `hoàn thành nhiệm vụ và leo bảng xếp hạng cùng bạn bè.\n\n` +
      `Bấm nút bên dưới để bắt đầu chơi 👇`;

    const replyMarkup = appUrl
      ? { inline_keyboard: [[{ text: "🎮 Chơi ngay", web_app: { url: appUrl } }]] }
      : undefined;

    await sendTelegramMessage(env.BOT_TOKEN, chatId, body, replyMarkup);
  }
}

function escapeHtmlTg(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // ── Webhook Telegram (/start ...) ──
      if (url.pathname === "/webhook" && request.method === "POST") {
        if (env.WEBHOOK_SECRET) {
          const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
          if (secretHeader !== env.WEBHOOK_SECRET) return json({ error: "unauthorized" }, 401);
        }
        if (!env.BOT_TOKEN) return json({ error: "BOT_TOKEN not configured" }, 500);

        const update = await request.json();
        await handleTelegramUpdate(update, env);
        return json({ ok: true });
      }

      // ── Cấu hình public cho client (bot username / short name để dựng link mời bạn) ──
      if (url.pathname === "/api/config" && request.method === "GET") {
        return json({
          botUsername: env.BOT_USERNAME || "",
          appShortName: env.APP_SHORT_NAME || "",
        });
      }

      // ── Lấy dữ liệu người chơi ──
      if (url.pathname === "/api/player" && request.method === "GET") {
        const id = url.searchParams.get("id");
        if (!id) return json({ error: "missing id" }, 400);
        const row = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(id).first();
        if (!row) return json({ player: null });
        return json({ player: withRegen(rowToPlayer(row)) });
      }

      // ── Lưu dữ liệu người chơi (đồng thời xử lý đăng ký giới thiệu + hoa hồng) ──
      if (url.pathname === "/api/player" && request.method === "POST") {
        const body = await request.json();
        const p = body.player;
        if (!p || !p.id || !p.nickname) return json({ error: "invalid payload" }, 400);

        if (!(await assertOwnsUid(env, body.initData, p.id))) {
          return json({ error: "invalid initData" }, 401);
        }

        const existing = await env.DB.prepare("SELECT * FROM players WHERE id = ?")
          .bind(p.id)
          .first();

        // referredBy chỉ được xác lập MỘT LẦN lúc tạo tài khoản — các lần lưu
        // sau đều giữ nguyên giá trị đã lưu trong DB, không tin theo client.
        let referredBy = existing ? existing.referred_by : null;

        if (!existing) {
          // Người chơi hoàn toàn mới — kiểm tra có tới từ link mời bạn hợp lệ không.
          const refId =
            body.referredBy && String(body.referredBy) !== String(p.id)
              ? String(body.referredBy)
              : null;
          if (refId) {
            // Kiểm tra ID người mời có THẬT SỰ tồn tại không trước khi cộng thưởng.
            const referrer = await env.DB.prepare("SELECT * FROM players WHERE id = ?")
              .bind(refId)
              .first();
            if (referrer) {
              referredBy = refId;
              const referredUsers = JSON.parse(referrer.referred_users || "[]");
              referredUsers.unshift({ id: p.id, nickname: p.nickname, ts: Date.now() });
              await env.DB.prepare(
                `UPDATE players SET coins = coins + ?, referral_count = referral_count + 1, referred_users = ?, updated_at = ? WHERE id = ?`
              )
                .bind(
                  REFERRAL_SIGNUP_BONUS,
                  JSON.stringify(referredUsers.slice(0, 200)),
                  Date.now(),
                  refId
                )
                .run();
            }
          }
        } else if (existing.referred_by) {
          // Người chơi cũ, có người giới thiệu — cộng hoa hồng 4% trên phần
          // coin họ VỪA kiếm thêm được so với lần lưu trước.
          const coinDelta = (p.coins || 0) - (existing.coins || 0);
          if (coinDelta > 0) {
            const commission = Math.floor(coinDelta * REFERRAL_COMMISSION_RATE);
            if (commission > 0) {
              await env.DB.prepare(
                `UPDATE players SET coins = coins + ?, referral_earnings = referral_earnings + ?, updated_at = ? WHERE id = ?`
              )
                .bind(commission, commission, Date.now(), existing.referred_by)
                .run();
            }
          }
        }

        const clampedLevel = Math.min(MINING_MAX_LEVEL, Math.max(1, Math.floor(p.miningLevel || 1)));
        const clampedXp = Math.max(0, Math.floor(p.miningXp || 0));

        // Lưu ý: KHÔNG đưa referral_count / referral_earnings / referred_users /
        // claimed_referral_milestones / gem_exchange_log vào phần UPDATE SET —
        // các cột này chỉ được server tự quản lý qua các thao tác riêng
        // (đăng ký giới thiệu, cộng hoa hồng, đổi gem, nhận thưởng mốc), tránh
        // bị client gửi dữ liệu cũ đè mất giá trị thật.
        await env.DB.prepare(
          `INSERT INTO players
            (id, nickname, username, avatar_url, coins, gems, energy, last_energy_ts, streak, last_checkin, total_taps, daily_taps, daily_taps_date, claimed_missions, mining_level, mining_xp, referred_by, referral_count, referral_earnings, claimed_referral_milestones, referred_users, gem_exchange_log, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,'[]','[]','[]',?)
           ON CONFLICT(id) DO UPDATE SET
             nickname = excluded.nickname,
             username = excluded.username,
             avatar_url = excluded.avatar_url,
             coins = excluded.coins,
             gems = excluded.gems,
             energy = excluded.energy,
             last_energy_ts = excluded.last_energy_ts,
             streak = excluded.streak,
             last_checkin = excluded.last_checkin,
             total_taps = excluded.total_taps,
             daily_taps = excluded.daily_taps,
             daily_taps_date = excluded.daily_taps_date,
             claimed_missions = excluded.claimed_missions,
             mining_level = excluded.mining_level,
             mining_xp = excluded.mining_xp,
             referred_by = excluded.referred_by,
             updated_at = excluded.updated_at`
        )
          .bind(
            p.id,
            p.nickname,
            p.username || null,
            p.avatarUrl || null,
            p.coins,
            p.gems || 0,
            p.energy,
            p.lastEnergyTs,
            p.streak,
            p.lastCheckin,
            p.totalTaps,
            p.dailyTaps,
            p.dailyTapsDate,
            JSON.stringify(p.claimedMissions || []),
            clampedLevel,
            clampedXp,
            referredBy,
            Date.now()
          )
          .run();

        return json({ ok: true });
      }

      // ── Đổi coin sang gem ──
      if (url.pathname === "/api/gem-exchange" && request.method === "POST") {
        const body = await request.json();
        const uid = body.uid;
        const coinAmount = Number(body.coinAmount);
        if (!uid || !Number.isFinite(coinAmount)) {
          return json({ ok: false, error: "invalid_payload" }, 400);
        }
        if (!(await assertOwnsUid(env, body.initData, uid))) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }
        if (!Number.isInteger(coinAmount) || coinAmount <= 0 || coinAmount % GEM_EXCHANGE_RATE !== 0) {
          return json({ ok: false, error: "invalid_amount" });
        }

        const row = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(uid).first();
        if (!row) return json({ ok: false, error: "player_not_found" }, 404);
        if (row.coins < coinAmount) return json({ ok: false, error: "insufficient_coins" });

        const gemsGained = coinAmount / GEM_EXCHANGE_RATE;
        const log = JSON.parse(row.gem_exchange_log || "[]");
        log.unshift({ coin: coinAmount, gem: gemsGained, ts: Date.now() });

        const newCoins = row.coins - coinAmount;
        const newGems = (row.gems || 0) + gemsGained;

        await env.DB.prepare(
          `UPDATE players SET coins = ?, gems = ?, gem_exchange_log = ?, updated_at = ? WHERE id = ?`
        )
          .bind(newCoins, newGems, JSON.stringify(log.slice(0, 20)), Date.now(), uid)
          .run();

        return json({ ok: true, coins: newCoins, gems: newGems, gemExchangeLog: log.slice(0, 20) });
      }

      // ── Nhận thưởng mốc mời bạn ──
      if (url.pathname === "/api/referral/claim-milestone" && request.method === "POST") {
        const body = await request.json();
        const uid = body.uid;
        const milestone = Number(body.milestone);
        const config = REFERRAL_MILESTONES.find((m) => m.count === milestone);
        if (!uid || !config) return json({ ok: false, error: "invalid_payload" }, 400);
        if (!(await assertOwnsUid(env, body.initData, uid))) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }

        const row = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(uid).first();
        if (!row) return json({ ok: false, error: "player_not_found" }, 404);

        const claimed = JSON.parse(row.claimed_referral_milestones || "[]");
        if (claimed.includes(milestone)) return json({ ok: false, error: "already_claimed" });
        if ((row.referral_count || 0) < milestone) return json({ ok: false, error: "not_reached" });

        claimed.push(milestone);
        const newCoins = row.coins + config.coin;
        const newGems = (row.gems || 0) + config.gem;

        await env.DB.prepare(
          `UPDATE players SET coins = ?, gems = ?, claimed_referral_milestones = ?, updated_at = ? WHERE id = ?`
        )
          .bind(newCoins, newGems, JSON.stringify(claimed), Date.now(), uid)
          .run();

        return json({
          ok: true,
          coins: newCoins,
          gems: newGems,
          claimedReferralMilestones: claimed,
          reward: config,
        });
      }

      // ── Bảng xếp hạng ──
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
