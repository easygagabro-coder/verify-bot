import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import "dotenv/config";

const app = express();
app.set("trust proxy", true); // 프록시 뒤에서도 실제 접속 IP 얻기 위함
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
  })
);

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI,
  DISCORD_BOT_TOKEN,
  GUILD_ID,
  VERIFIED_ROLE_ID,
  INVITE_TARGET_GUILD_ID,
  IPQS_API_KEY,
  ADMIN_PASSWORD,
  PORT,
} = process.env;

// ---- 영구 저장소 (간단한 JSON 파일 기반. 트래픽 많아지면 SQLite/Redis로 교체 권장) ----
const DB_FILE = path.join(process.cwd(), "verified-users.json");

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// 발급된 초대 키 임시 저장 (메모리) - 10분 후 만료되는 1회용 키
const inviteKeys = new Map(); // key -> { userId, createdAt, ip }

function getClientIp(req) {
  // Cloudflare / 일반 프록시 헤더 우선순위
  return (
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress
  );
}

async function checkVpn(ip) {
  if (!IPQS_API_KEY) return { isVpn: false, skipped: true };
  try {
    const res = await fetch(
      `https://ipqualityscore.com/api/json/ip/${IPQS_API_KEY}/${ip}?strictness=1`
    );
    const data = await res.json();
    return {
      isVpn: data.vpn || data.proxy || data.tor || data.fraud_score > 75,
      raw: data,
    };
  } catch (e) {
    console.error("IPQS 조회 실패:", e.message);
    return { isVpn: false, error: true };
  }
}

// 1) 인증 시작 -> Discord OAuth 화면으로 리다이렉트
app.get("/verify", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: "code",
    scope: "identify email guilds.join",
    state,
    prompt: "consent",
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// 2) Discord가 콜백으로 code를 보내줌
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || state !== req.session.oauthState) {
    return res.status(400).send("인증 요청이 유효하지 않습니다. 다시 시도해주세요.");
  }

  const ip = getClientIp(req);

  try {
    // access token 교환
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error("토큰 교환 실패:", tokenData);
      return res.status(400).send("인증에 실패했습니다.");
    }

    // 유저 정보 조회
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    // 계정 생성일 계산 (스노우플레이크 ID 기반)
    const DISCORD_EPOCH = 1420070400000n;
    const timestamp = (BigInt(user.id) >> 22n) + DISCORD_EPOCH;
    const accountAgeDays =
      (Date.now() - Number(timestamp)) / (1000 * 60 * 60 * 24);

    // VPN 체크
    const vpnResult = await checkVpn(ip);

    const isSuspicious =
      vpnResult.isVpn || accountAgeDays < 3; // 최근 3일 내 생성 계정 등 기준은 조절 가능

    if (isSuspicious) {
      return res.status(403).send(`
        <h2>인증 실패</h2>
        <p>비정상적인 접근으로 판단되어 인증이 거부되었습니다.</p>
        <p style="color:gray">VPN/프록시 사용 또는 신규 계정으로 감지됨</p>
      `);
    }

    // 봇 토큰으로 서버에 강제 참가 (guilds.join)
    if (INVITE_TARGET_GUILD_ID) {
      await fetch(
        `https://discord.com/api/guilds/${INVITE_TARGET_GUILD_ID}/members/${user.id}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ access_token: tokenData.access_token }),
        }
      );
    }

    // role 부여
    if (GUILD_ID && VERIFIED_ROLE_ID) {
      await fetch(
        `https://discord.com/api/guilds/${GUILD_ID}/members/${user.id}/roles/${VERIFIED_ROLE_ID}`,
        {
          method: "PUT",
          headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
        }
      );
    }

    // 특정 방 입장용 1회용 키 발급
    const inviteKey = crypto.randomBytes(12).toString("hex");
    inviteKeys.set(inviteKey, {
      userId: user.id,
      ip,
      createdAt: Date.now(),
    });

    // 관리자 패널용 영구 기록 (IP, 이메일, 재초대 키)
    const db = loadDb();
    db[user.id] = {
      username: user.username,
      email: user.email || null,
      ip,
      accountAgeDays: Math.floor(accountAgeDays),
      lastInviteKey: inviteKey,
      verifiedAt: new Date().toISOString(),
      vpnFlag: vpnResult.isVpn || false,
    };
    saveDb(db);

    res.send(`
      <h2>인증 완료 ✅</h2>
      <p>${user.username}님, 인증이 완료되었습니다.</p>
      <p>발급된 키: <code>${inviteKey}</code></p>
      <p style="color:gray">이 키는 10분간 유효합니다.</p>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("서버 오류가 발생했습니다.");
  }
});

// 3) 발급된 키 검증용 엔드포인트 (봇이 이걸 호출해서 방 입장 처리)
app.get("/api/redeem/:key", (req, res) => {
  const entry = inviteKeys.get(req.params.key);
  if (!entry) return res.status(404).json({ ok: false });

  const expired = Date.now() - entry.createdAt > 10 * 60 * 1000;
  if (expired) {
    inviteKeys.delete(req.params.key);
    return res.status(410).json({ ok: false, reason: "expired" });
  }

  inviteKeys.delete(req.params.key); // 1회용
  res.json({ ok: true, userId: entry.userId });
});

// ---- 관리자 패널 ----

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.redirect("/admin/login");
}

app.get("/admin/login", (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;background:#1e1f22;color:#eee;display:flex;justify-content:center;align-items:center;height:100vh;">
      <form method="POST" action="/admin/login" style="background:#2b2d31;padding:30px;border-radius:8px;">
        <h2>관리자 로그인</h2>
        <input type="password" name="password" placeholder="비밀번호" style="padding:8px;width:100%;box-sizing:border-box;margin-bottom:10px;" />
        <button type="submit" style="padding:8px 16px;width:100%;">로그인</button>
      </form>
    </body></html>
  `);
});

app.post("/admin/login", (req, res) => {
  if (req.body.password && req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect("/admin");
  }
  res.status(401).send("비밀번호가 틀렸습니다. <a href='/admin/login'>다시 시도</a>");
});

app.get("/admin/logout", (req, res) => {
  req.session.isAdmin = false;
  res.redirect("/admin/login");
});

app.get("/admin", requireAdmin, (req, res) => {
  const db = loadDb();
  const rows = Object.entries(db)
    .sort((a, b) => new Date(b[1].verifiedAt) - new Date(a[1].verifiedAt))
    .map(
      ([userId, u]) => `
      <tr>
        <td>${u.username}</td>
        <td>${userId}</td>
        <td>${u.email || "-"}</td>
        <td>${u.ip}</td>
        <td>${u.accountAgeDays}일</td>
        <td>${u.vpnFlag ? "⚠️ 의심됨" : "정상"}</td>
        <td><code>${u.lastInviteKey}</code></td>
        <td>${new Date(u.verifiedAt).toLocaleString("ko-KR")}</td>
        <td><form method="POST" action="/admin/reinvite/${userId}" style="margin:0;"><button>재초대 키 발급</button></form></td>
      </tr>
    `
    )
    .join("");

  res.send(`
    <html><head><meta charset="utf-8"><title>인증 관리자 패널</title></head>
    <body style="font-family:sans-serif;background:#1e1f22;color:#eee;padding:20px;">
      <h2>인증된 유저 목록 (${Object.keys(db).length}명)</h2>
      <p><a href="/admin/logout" style="color:#f66;">로그아웃</a></p>
      <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;background:#2b2d31;">
        <tr style="background:#3a3c42;">
          <th>유저명</th><th>ID</th><th>이메일</th><th>IP</th><th>계정나이</th><th>VPN여부</th><th>최근 발급 키</th><th>인증시각</th><th>동작</th>
        </tr>
        ${rows || "<tr><td colspan='9'>아직 인증한 유저가 없습니다.</td></tr>"}
      </table>
    </body></html>
  `);
});

// 관리자가 특정 유저에게 새 재초대 키를 발급 (예: 서버 재입장용)
app.post("/admin/reinvite/:userId", requireAdmin, (req, res) => {
  const db = loadDb();
  const user = db[req.params.userId];
  if (!user) return res.status(404).send("유저를 찾을 수 없습니다.");

  const newKey = crypto.randomBytes(12).toString("hex");
  inviteKeys.set(newKey, {
    userId: req.params.userId,
    ip: user.ip,
    createdAt: Date.now(),
  });
  user.lastInviteKey = newKey;
  saveDb(db);

  res.redirect("/admin");
});

app.listen(PORT || 3000, () => {
  console.log(`웹서버 실행 중: http://localhost:${PORT || 3000}`);
});
