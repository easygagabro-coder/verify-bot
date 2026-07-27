# Verify Bot 설치 가이드

## 1. Discord Developer Portal 설정
1. https://discord.com/developers/applications 에서 앱 생성
2. OAuth2 탭 → Redirect: `https://your-domain.com/callback` 등록
3. Bot 탭 → 토큰 발급, `Server Members Intent` 켜기
4. General Information에서 Client ID, Client Secret 복사

### 봇을 서버에 초대하기 (최초 1회, 관리자만)
OAuth2 → URL 생성기에서:
- 스코프: `bot`, `applications.commands` 체크
- 권한: `Manage Roles`, `Send Messages`, `Embed Links` 등 필요한 권한 체크
- 생성된 URL로 접속해서 봇을 서버에 초대

이 초대는 **유저 인증 흐름과는 별개**입니다. 봇이 서버에서 활동(임베드 전송, role 부여)하려면 이 초대가 먼저 되어 있어야 해요.

### 유저 인증 링크 (봇이 자동으로 붙여줌)
`bot.js`가 `/verify` 링크를 버튼에 넣어서 전송합니다. 이 링크를 유저가 클릭하면 스코프 `identify email guilds.join`으로 OAuth 동의 화면이 뜹니다 (코드에 이미 구현됨, Developer Portal에서 별도로 만들 필요 없음).

## 2. 환경변수 설정
`.env.example`을 `.env`로 복사 후 값 채우기

```bash
cp .env.example .env
```

- `IPQS_API_KEY`는 https://www.ipqualityscore.com 무료 가입 시 발급 (하루 5000건)
- `GUILD_ID`, `VERIFIED_ROLE_ID`는 디스코드에서 개발자모드 켜고 우클릭 → ID 복사

## 3. 설치 및 실행

```bash
npm install

# 슬래시 커맨드 1회 등록
node bot/register-commands.js

# 웹서버 (OAuth 콜백 처리) - 실제 도메인/HTTPS 필요
npm run start:web

# 봇 (인증 패널 전송)
npm run start:bot
```

디스코드 채널에서 `/인증패널` 입력하면 인증 버튼 임베드가 올라갑니다.

## 4. 호스팅 관련 중요 사항

**"디스호스트" 같은 봇 전용 호스팅은 대부분 봇 프로세스만 24시간 실행해주고, 
외부에서 접속 가능한 HTTPS 웹서버(OAuth 콜백용)는 별도로 필요합니다.**

- Discord OAuth2는 `redirect_uri`가 **반드시 HTTPS**여야 정상 동작합니다 (localhost 제외).
- 추천 조합:
  - **웹서버**: Railway, Render, Fly.io (무료 티어로 시작 가능, 자동 HTTPS 도메인 제공)
  - **봇 프로세스**: 디스호스트 등 봇 전용 호스팅 그대로 사용
- 두 개를 같은 곳에 올리고 싶다면, 그 호스팅이 "웹 서비스(HTTP 포트 오픈)"를 지원하는지 먼저 확인하세요.

## 5. 동작 흐름

1. 유저가 임베드의 "Verify my account" 버튼 클릭
2. `/verify` → Discord OAuth2 동의 화면 (identify, email, guilds.join)
3. 동의 시 `/callback`으로 code 전달됨
4. 서버가 access token 교환 → 유저 정보 + 실제 접속 IP 확인
5. IPQualityScore로 VPN/프록시 여부 체크, 계정 생성일 확인
6. 통과 시:
   - `guilds.join`으로 지정된 서버에 자동 참가
   - 지정 role 자동 부여
   - 10분간 유효한 1회용 키 발급 (특정 방 입장 등에 활용 가능)
7. 실패 시 403 응답과 사유 표시

## 관리자 패널

`https://your-domain.com/admin` 접속 → `.env`의 `ADMIN_PASSWORD`로 로그인

여기서 확인 가능한 정보:
- 인증한 유저의 유저명 / ID / 이메일 / 접속 IP
- 계정 나이, VPN 의심 여부
- 최근 발급된 재초대 키
- **"재초대 키 발급" 버튼** — 누르면 그 유저용 새 1회용 키를 즉시 생성 (서버에서 내보냈다가 다시 불러올 때 등에 활용)

데이터는 `verified-users.json` 파일에 저장됩니다 (서버 재시작해도 유지). 유저 수가 많아지면 SQLite 등으로 옮기는 게 좋습니다.

## 주의사항

- 이메일 스코프(`email`)는 실제로 필요한 경우에만 요청하세요. 불필요하게 광범위한 권한 요청은 유저 신뢰를 떨어뜨립니다.
- IP/이메일 등 개인정보를 저장한다면 최소한의 보관 기간과 목적을 서버 안내 문구에 명시하는 게 좋습니다 (상업적 목적이 아니어도 개인정보처리 원칙은 지키는 게 안전합니다).
- `inviteKeys`는 메모리 저장이라 서버 재시작 시 초기화됩니다. 운영 단계에서는 Redis나 SQLite 사용을 권장합니다.
