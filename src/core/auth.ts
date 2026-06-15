// Google OAuth 登入保護（stateless 簽章 cookie 版）
// - 不用 server-side session：OAuth state 與登入身分都放「簽章 cookie」，
//   跨 Cloud Run instance / 重新部署皆有效（@fastify/session 的 MemoryStore 在
//   Cloud Run 上會掉 session，且 secure cookie 需配合 trustProxy，見 server.ts）。
// - 可登入名單比照 timeoff-system：網域(popin.cc/broadciel.com) + timeoff DB 在職員工。
// 未設定 OAuth env 時自動停用（僅限本機開發）。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { randomUUID } from 'node:crypto';
import { employeeCheckEnabled, isActiveEmployee } from './employees.js';
import { layout } from './html.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URL = process.env.GOOGLE_REDIRECT_URL;
// 網域白名單（逗號或分號分隔；gcloud --update-env-vars 以逗號切多組 env，故部署值用分號）。
// 預設比照 timeoff：popin.cc + broadciel.com
const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS ?? process.env.ALLOWED_EMAIL_DOMAIN ?? 'popin.cc;broadciel.com')
  .split(/[,;]/)
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS ?? '')
  .split(/[,;]/)
  .map((s) => s.trim())
  .filter(Boolean);

const STATE_COOKIE = 'oauth_state';
const SESSION_COOKIE = 'session_user';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 秒；30 天，比照 timeoff-system

export const AUTH_ENABLED = !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URL);

function domainAllowed(email: string): boolean {
  return ALLOWED_DOMAINS.some((d) => email.endsWith(`@${d}`)) || ALLOWED_EMAILS.includes(email);
}

function loginPage(msg = ''): string {
  return layout(
    '登入',
    `<div class="flex justify-center mt-24">
  <div class="card bg-base-100 shadow-md w-96">
    <div class="card-body items-center text-center">
      <h1 class="card-title">內部廣告工具系統</h1>
      ${msg ? `<div class="alert alert-error text-sm">${msg}</div>` : ''}
      <a href="/auth/google/login" class="btn btn-primary mt-2 w-full">使用 Google 登入</a>
    </div>
  </div>
</div>`,
    { nav: false }
  );
}

/** 從簽章 cookie 取出已登入 email；無效/未登入回 null */
function currentUser(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const { valid, value } = req.unsignCookie(raw);
  return valid && value ? value : null;
}

export async function registerAuth(app: FastifyInstance) {
  if (!AUTH_ENABLED) {
    app.log.warn('⚠ Google OAuth 未設定，登入保護停用（僅限本機開發）');
    return;
  }

  const secret = process.env.SESSION_SECRET ?? '';
  if (secret.length < 32) throw new Error('SESSION_SECRET 需至少 32 字元');

  await app.register(cookie, { secret }); // secret 啟用 cookie 簽章

  app.get('/login', (_req, reply) => reply.type('text/html').send(loginPage()));

  app.get('/auth/google/login', (req, reply) => {
    const state = randomUUID();
    // state 放短效簽章 cookie（10 分鐘），callback 驗證用
    reply.setCookie(STATE_COOKIE, state, {
      path: '/',
      signed: true,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 600,
    });
    const url =
      'https://accounts.google.com/o/oauth2/v2/auth?' +
      new URLSearchParams({
        client_id: CLIENT_ID!,
        redirect_uri: REDIRECT_URL!,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        prompt: 'select_account',
      });
    reply.redirect(url);
  });

  app.get('/auth/google/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const rawState = req.cookies[STATE_COOKIE];
    const unsigned = rawState ? req.unsignCookie(rawState) : { valid: false as const, value: null };
    reply.clearCookie(STATE_COOKIE, { path: '/' });

    if (!code || !state || !unsigned.valid || unsigned.value !== state) {
      return reply.code(400).type('text/html').send(loginPage('登入驗證失敗，請重試'));
    }

    const tok: any = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID!,
        client_secret: CLIENT_SECRET!,
        redirect_uri: REDIRECT_URL!,
        grant_type: 'authorization_code',
      }),
    }).then((r) => r.json());

    const info: any = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    }).then((r) => r.json());

    const email = (info.email ?? '').toLowerCase().trim();

    // 閘門 1：網域白名單
    if (!email || !domainAllowed(email)) {
      return reply.code(403).type('text/html').send(loginPage(`無使用權限：${email || '未知帳號'}`));
    }

    // 閘門 2：timeoff 在職員工名單（DB 未設定時降級為僅網域檢查；查詢失敗 fail-closed）
    if (employeeCheckEnabled()) {
      let active: boolean;
      try {
        active = await isActiveEmployee(email);
      } catch (e: any) {
        app.log.error({ err: e }, '在職員工檢查失敗');
        return reply.code(500).type('text/html').send(loginPage('員工名單檢查暫時無法使用，請稍後重試或聯絡管理員'));
      }
      if (!active) {
        return reply.code(403).type('text/html').send(loginPage(`無使用權限（非在職員工名單）：${email}`));
      }
    } else {
      app.log.warn('TIMEOFF_DB 未設定，僅以網域白名單檢查');
    }

    // 登入成功：發 30 天簽章 cookie
    reply.setCookie(SESSION_COOKIE, email, {
      path: '/',
      signed: true,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE,
    });
    reply.redirect('/');
  });

  app.get('/logout', (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.redirect('/login');
  });

  // 守衛：未登入一律導向 /login（除外：登入相關、健康檢查、排程 webhook）
  // `/tools/*/cron`＝Cloud Scheduler 打的排程入口，沒有登入 cookie，靠各自 DIAG_KEY 守衛（同 /health 模式）
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === '/login' || path.startsWith('/auth/') || path.startsWith('/health') || path.endsWith('/cron')) return;
    if (!currentUser(req)) return reply.redirect('/login');
  });
}
