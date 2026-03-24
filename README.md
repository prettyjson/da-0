# The O Club

A private, credential-gated social network for military veterans — built as a real-time web app with voice rooms, on-chain dues, and a Clubhouse-style audio experience.

Members verify with their DD-214, get an embedded crypto wallet on Base, and join a self-governing community with chat channels, live voice "nets," treasury voting, and automatic USDC dues collection.

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   Client (Vite)                  │
│  index.html + app.js + voice.js + wallet.js      │
│  map.js (Leaflet) + styles.css                   │
└──────────┬──────────────┬───────────────┬────────┘
           │ HTTP/WS      │ WebRTC        │ EIP-712
           ▼              ▼               ▼
┌──────────────┐  ┌───────────────┐  ┌──────────────┐
│  Express +   │  │  Cloudflare   │  │  Coinbase    │
│  WebSocket   │  │  Calls SFU    │  │  CDP Wallet  │
│  server.js   │  │  (voice)      │  │  (Base L2)   │
└──────┬───────┘  └───────────────┘  └──────────────┘
       │
       ▼
┌──────────────┐
│  Supabase    │
│  (Postgres)  │
│  + SQLite    │
│  fallback    │
└──────────────┘
```

### Key Modules

| File | What it does |
|---|---|
| `server.js` | Express API + WebSocket hub. Auth, channels, messages, nets, voice room coordination, treasury, voting, referrals, member locations |
| `app.js` | Client-side SPA. Onboarding flow (DD-214 OCR + face match), chat, voice UI, treasury dashboard, proposals, member map |
| `voice.js` | Client WebRTC layer. Opus 48kHz, speaker detection via Web Audio AnalyserNode, join/leave/mute audio cues, auto-reconnect |
| `cloudflare-voice.js` | Server-side Cloudflare Calls integration. Session management, track push/pull routing, room state |
| `wallet.js` | Coinbase CDP embedded wallet. Email OTP + Google OAuth login, ERC-4337 smart accounts, gasless transactions on Base |
| `spend-permissions.js` | EIP-712 SpendPermission signing for recurring $10/month USDC dues. One signature covers 365 days |
| `jobs/collect-dues.js` | Cron job that auto-pulls dues from members via on-chain `spend()` calls |
| `map.js` | Leaflet + MarkerCluster world map showing member locations with connection lines between cities |

## Features

**Identity & Auth**
- DD-214 upload with OCR extraction (Tesseract.js) and webcam face verification (face-api.js)
- Coinbase CDP embedded wallet — email OTP or Google OAuth, auto-provisions an ERC-4337 smart account on Base
- Fallback username/password auth for development

**Voice Rooms ("Nets")**
- Clubhouse-style audio rooms via Cloudflare Calls SFU
- Roles: host, co-host, speaker, listener with hand-raise promotion
- Real-time speaking indicators, mute/unmute with audio cues
- Opus 48kHz, echo cancellation, noise suppression, auto-gain
- Exponential backoff reconnection on ICE failures

**Chat**
- Slack-style channels (General, Officers Club, NCO Club, Intel Brief)
- DMs, threaded replies, emoji reactions, image attachments
- Real-time delivery via WebSocket

**Treasury & Governance**
- On-chain USDC treasury on Base with transparent allocation tracking
- Proposal system with weighted voting (vote weight = stake percentage)
- Quorum-based resolution (67% default threshold)

**Dues & Payments**
- $10/month USDC auto-collected via EIP-712 SpendPermission
- Single signature authorizes 365 days of recurring pulls
- Pro-rated first month, points awarded on payment
- Members can revoke permissions from settings at any time

**Member Map**
- Interactive world map (Leaflet + dark CartoDB tiles)
- MarkerCluster for dense regions, connection lines between cities

## Tech Stack

- **Frontend**: Vanilla JS SPA, Vite, CSS (no framework)
- **Backend**: Node.js, Express, WebSocket (`ws`)
- **Database**: Supabase (Postgres) with SQLite fallback (better-sqlite3)
- **Voice**: Cloudflare Calls (WebRTC SFU)
- **Wallet**: Coinbase CDP (`@coinbase/cdp-core`), ERC-4337 smart accounts
- **Chain**: Base (Ethereum L2), USDC, SpendPermissionManager contract
- **Maps**: Leaflet + leaflet.markercluster
- **OCR/Face**: Tesseract.js, face-api.js (client-side, no data leaves browser)
- **Deploy**: Railway (nixpacks)

## Setup

```bash
cp .env.example .env
# Fill in your Supabase, Coinbase CDP, and Cloudflare Calls credentials

npm install
npm run dev
```

The app runs without external services configured — it falls back to SQLite and stubs wallet/voice features. See `.env.example` for the full list of optional integrations.

## Database

Two schema paths:

- **`db/schema.sql`** — SQLite schema with seed data for local development
- **`supabase/migrations/001_initial_schema.sql`** — Production Postgres schema with UUIDs, proper types, indexes, and RLS-ready structure

## License

MIT
