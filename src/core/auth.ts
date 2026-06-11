// Google OAuth 登入保護（比照 lunchbox 模式）
// 未設定 OAuth env 時自動停用（僅限本機開發）。正式環境由 env 提供 client/secret。
import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import { randomUUID } from 'node:crypto';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URL = process.env.GOOGLE_REDIRECT_URL;
const ALLOWED_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN ?? 'popin.cc';
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const AUTH_ENABLED = !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URL);

function emailAllowed(email: string): boolean {
  return email.endsWith(`@${ALLOWED_DOMAIN}`) || ALLOWED_EMAILS.includes(email);
}

function loginPage(msg = ''): string {
  return `<!doctype html><meta charset="utf-8"><title>登入</title>
<div style="font-family:system-ui;max-width:420px;margin:6rem auto;text-align:center">
  <h1 style="font-size:1.3rem">內部廣告工具系統</h1>
  ${msg ? `<p style="color:#c00">${msg}</p>` : ''}
  <a href="/auth/google/login" style="display:inline-block;margin-top:1rem;background:#1565c0;color:#fff;padding:.7rem 1.4rem;border-radius:6px;text-decoration:none">使用 Google 登入</a>
</div>`;
}

export async function registerAuth(app: FastifyInstance) {
  if (!AUTH_ENABLED) {
    app.log.warn('⚠ Google OAuth 未設定，登入保護停用（僅限本機開發）');
    return;
  }

  const secret = process.env.SESSION_SECRET ?? '';
  if (secret.length < 32) throw new Error('SESSION_SECRET 需至少 32 字元');

  await app.register(cookie);
  await app.register(session, {
    secret,
    cookie: { secure: true, httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' }, // 30 天，比照 timeoff-system
  });

  app.get('/login', (_req, reply) => reply.type('text/html').send(loginPage()));

  app.get('/auth/google/login', (req, reply) => {
    const state = randomUUID();
    (req.session as any).oauthState = state;
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
    if (!code || !state || state !== (req.session as any).oauthState) {
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

    if (!info.email || !emailAllowed(info.email)) {
      return reply.code(403).type('text/html').send(loginPage(`無使用權限：${info.email ?? '未知帳號'}`));
    }
    (req.session as any).user = info.email;
    reply.redirect('/');
  });

  app.get('/logout', (req, reply) => {
    (req.session as any).destroy?.(() => {});
    reply.redirect('/login');
  });

  // 守衛：未登入一律導向 /login（健康檢查與登入相關路由除外）
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path === '/login' || path.startsWith('/auth/') || path.startsWith('/health')) return;
    if (!(req.session as any).user) return reply.redirect('/login');
  });
}
