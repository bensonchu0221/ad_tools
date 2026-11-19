/**
 * tool#11 IO／Cue 單 路由（`/tools/iocue`）。
 *
 * 頁面是單頁（hash 路由：#/ 首頁看板、#/p/<單號> 編輯與核對、#/p/<單號>/send 寄出與回簽、#/roles 角色）；
 * 資料都走 JSON API。業務規則在 service.ts／model.ts，這裡只做 HTTP 轉換與身分。
 *
 * 角色（iocue_roles）由 admin 在 #/roles 維護；表是空的時候 IOCUE_ADMINS（預設 benson@popin.cc）自動是 admin，避免沒人能進設定。
 * 本機沒開 OAuth 時以 IOCUE_DEV_USER 當登入者（預設 benson@popin.cc），方便本機 demo。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { currentUser, AUTH_ENABLED } from '../../core/auth.js';
import { iocuePage } from './page.js';
import * as svc from './service.js';
import * as S from './store.js';
import { loadMasters } from './masters.js';
import { cueXlsx } from './xlsx.js';
import { parsePaste, ROLE_LABEL, type Role, type IoAction, type CueAction } from './model.js';
import { TERMS, ENTITY_INFO, PAYMENT_TERMS } from './config.js';
import { postChat } from '../nexus/health.js';

export const BASE_PATH = '/tools/iocue';
const APP_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/iocue/app.js');
const API = `${BASE_PATH}/api`;

const ADMINS = (process.env.IOCUE_ADMINS ?? 'benson@popin.cc').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const ALL_ROLES = Object.keys(ROLE_LABEL) as Role[];

const twToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

async function ctxOf(req: FastifyRequest): Promise<svc.Ctx> {
  // 跟 core/auth.ts 用同一個判斷（三個 OAuth env 齊全才算開；審查 #17.7）：只設了 CLIENT_ID 時不會誤用 dev 身分
  const email = (currentUser(req) ?? (AUTH_ENABLED ? '' : process.env.IOCUE_DEV_USER ?? 'benson@popin.cc')).toLowerCase();
  if (!email) throw new svc.HttpError(401, '請先登入');
  const { roles } = await S.rolesOf(email);
  const out = new Set(roles);
  if (ADMINS.includes(email)) out.add('admin');
  return { email, ip: req.ip, roles: [...out] };
}

function fail(reply: FastifyReply, req: FastifyRequest, e: unknown) {
  if (e instanceof svc.HttpError) return reply.code(e.status).send({ error: e.message });
  // @fastify/multipart 超過 15MB 丟的不是 HttpError（審查 #14：原本回 500＋英文訊息）
  if ((e as any)?.code === 'FST_REQ_FILE_TOO_LARGE' || (e as any)?.statusCode === 413) return reply.code(413).send({ error: '檔案超過 15 MB' });
  req.log.error(e);
  return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
}

/** 包一層：取身分、錯誤轉 JSON。 */
const h = (fn: (req: FastifyRequest, ctx: svc.Ctx, reply: FastifyReply) => Promise<unknown>) =>
  async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const ctx = await ctxOf(req);
      const out = await fn(req, ctx, reply);
      if (!reply.sent) reply.send(out);
    } catch (e) {
      fail(reply, req, e);
    }
  };

const noOf = (req: FastifyRequest) => {
  const no = String((req.params as any).no ?? '');
  if (!/^IO-\d{4}-[A-Z2-9]{5}$/.test(no)) throw new svc.HttpError(400, '單號格式不對');
  return no;
};
const verOf = (req: FastifyRequest) => {
  const v = Number((req.params as any).ver);
  if (!Number.isInteger(v) || v < 1) throw new svc.HttpError(400, '版本號不對');
  return v;
};
const sendFile = (reply: FastifyReply, name: string, type: string, buf: Buffer, inline = false) => {
  // 使用者上傳的檔跟登入 cookie 同源：不讓瀏覽器猜類型、內嵌時關掉腳本（審查 #14）；.eml 一律下載不內嵌
  const asInline = inline && type !== 'message/rfc822';
  reply.header('Content-Disposition', `${asInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', 'sandbox');
  reply.type(type).send(buf);
};

/*
 * 寫 BQ：不在鎖定當下觸發，由每天 06:00 的 sales 同步（Cloud Scheduler sales-sync）帶上（2026-11-20 審查 #1）。
 * 原本鎖定後在背景 setTimeout 20 秒跑 runSync：Cloud Run 改成 --cpu-throttling 後回應完 CPU 就被壓住、跑不完；
 * 也沒跟 06:00 排程互斥（兩邊共用同一組 BQ 暫存表會互刪）；還會在白天把財務正在改的試算表半成品一起寫進去。
 */
export function registerIocue(app: FastifyInstance, deps: { postChat?: (t: string) => Promise<unknown> } = {}): void {
  const chat = deps.postChat ?? postChat;
  svc.hooks.notify = (t) => { chat(t).catch(() => {}); };

  app.get(BASE_PATH, async (_req, reply) => { reply.type('text/html').send(iocuePage()); });
  // 前端程式放 public/iocue/app.js（tsc 不會把 src 裡的 .js 帶進 dist；public 整包進映像）。正式環境讀一次就快取。
  let appJs: string | null = null;
  app.get(`${BASE_PATH}/app.js`, async (_req, reply) => {
    if (!appJs || process.env.NODE_ENV !== 'production') appJs = readFileSync(APP_JS, 'utf8');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable').type('application/javascript; charset=utf-8').send(appJs);
  });

  app.get(`${API}/me`, h(async (_req, ctx) => {
    const r = await S.rolesOf(ctx.email);
    return { email: ctx.email, name: r.name, roles: ctx.roles };
  }));

  app.get(`${API}/meta`, h(async () => {
    const [masters, roles] = await Promise.all([loadMasters(), S.listRoles()]);
    return {
      // 條款全文也給前端（審查 #17.4：原本編輯頁寫死 2026.11 版的精簡文案）
      masters, terms: TERMS, entities: Object.keys(ENTITY_INFO), paymentTerms: PAYMENT_TERMS,
      people: roles.map((r) => ({ email: r.email, name: r.name, roles: r.roles })),
    };
  }));

  app.get(`${API}/projects`, h(async () => {
    const rows = await S.listProjects(await S.q());
    return { today: twToday(), rows };
  }));

  app.post(`${API}/projects`, h(async (req, ctx) => ({ projectNo: await svc.createProject(req.body, ctx, twToday()) })));

  app.get(`${API}/projects/:no`, h(async (req, ctx) => ({ today: twToday(), me: ctx, ...(await svc.detail(noOf(req), ctx)) })));

  app.put(`${API}/projects/:no/draft`, h(async (req, ctx) => svc.saveDraft(noOf(req), req.body, ctx)));

  app.post(`${API}/projects/:no/io/:ver/:action`, h(async (req, ctx) => {
    const action = String((req.params as any).action) as IoAction;
    if (!['submit', 'approve', 'reject', 'sign', 'void'].includes(action)) throw new svc.HttpError(400, '不認得的動作');
    return svc.ioAction(noOf(req), verOf(req), action, req.body, ctx, twToday());
  }));
  app.post(`${API}/projects/:no/cue/:ver/:action`, h(async (req, ctx) => {
    const action = String((req.params as any).action) as CueAction;
    if (!['submit', 'confirm', 'reject', 'void'].includes(action)) throw new svc.HttpError(400, '不認得的動作');
    return svc.cueAction(noOf(req), verOf(req), action, req.body, ctx);
  }));
  app.post(`${API}/projects/:no/new/:which`, h(async (req, ctx) => {
    const which = String((req.params as any).which);
    if (which !== 'io' && which !== 'cue') throw new svc.HttpError(400, '只能開 io 或 cue 新版');
    return svc.newVersion(noOf(req), which, ctx);
  }));
  app.put(`${API}/projects/:no/cue/:ver/bindings`, h(async (req, ctx) => svc.setBindings(noOf(req), verOf(req), (req.body as any)?.bindings, ctx)));
  app.post(`${API}/projects/:no/io/:ver/sent`, h(async (req, ctx) => svc.markSent(noOf(req), verOf(req), ctx)));
  app.post(`${API}/projects/:no/status`, h(async (req, ctx) => {
    const st = String((req.body as any)?.status);
    if (!['active', 'closed', 'terminated'].includes(st)) throw new svc.HttpError(400, '狀態不對');
    return svc.setProjectStatus(noOf(req), st as 'active', String((req.body as any)?.reason ?? ''), ctx);
  }));

  // 上傳客戶憑證：multipart，欄位 kind、ver、file
  app.post(`${API}/projects/:no/upload`, h(async (req, ctx) => {
    let kind = '', ver = 0, file: { name: string; type: string; buf: Buffer } | null = null;
    for await (const part of (req as any).parts()) {
      if (part.type === 'file') file = { name: part.filename ?? 'file', type: part.mimetype ?? '', buf: await part.toBuffer() };
      else if (part.fieldname === 'kind') kind = String(part.value);
      else if (part.fieldname === 'ver') ver = Number(part.value);
    }
    if (!file) throw new svc.HttpError(400, '沒有收到檔案');
    return svc.uploadEvidence(noOf(req), kind, ver, file, ctx);
  }));
  app.get(`${API}/projects/:no/files/:id`, h(async (req, _ctx, reply) => {
    const { file, buf } = await svc.fileContent(noOf(req), Number((req.params as any).id));
    sendFile(reply, file.fileName, file.contentType, buf, (req.query as any)?.inline === '1');
  }));

  app.get(`${API}/projects/:no/pdf`, h(async (req, ctx, reply) => {
    const q = req.query as any;
    const kind = q?.kind === 'cue' ? 'cue' : 'io';
    const ver = q?.ver ? Number(q.ver) : null;
    const { name, buf } = await svc.pdfFor(noOf(req), kind, ver, ctx, twToday());
    sendFile(reply, name, 'application/pdf', buf, q?.inline === '1');
  }));
  app.get(`${API}/projects/:no/xlsx`, h(async (req, _ctx, reply) => {
    const no = noOf(req);
    const full = await S.loadProject(await S.q(), no);
    if (!full) throw new svc.HttpError(404, `找不到專案 ${no}`);
    const ver = (req.query as any)?.ver ? Number((req.query as any).ver) : null;
    const cue = (ver ? full.cues.find((c) => c.ver === ver) : full.cues.filter((c) => c.status !== 'void').at(-1)) ?? null;
    if (!cue) throw new svc.HttpError(404, '沒有 Cue 表');
    const io = full.ios.filter((x) => x.status !== 'void').at(-1);
    const buf = await cueXlsx({
      projectNo: no, projectName: full.project.name, versionLabel: `Cue v${cue.ver}`, draft: cue.status !== 'confirmed',
      lines: cue.lines, taxRate: io?.taxRate ?? 0.05,
    });
    sendFile(reply, `${no}_Cue-v${cue.ver}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf);
  }));
  app.get(`${API}/projects/:no/audit`, h(async (req) => {
    const qq = await S.q();
    const full = await S.loadProject(qq, noOf(req));
    if (!full) throw new svc.HttpError(404, '找不到專案');
    return S.listAudit(qq, full.project.id);
  }));

  // 從 Excel 貼上：後端解析（跟前端同一套規則），回傳明細給使用者確認後再存
  app.post(`${API}/paste`, h(async (req) => parsePaste(String((req.body as any)?.text ?? ''), Number((req.body as any)?.startNo ?? 1))));

  // 角色維護（admin）
  app.get(`${API}/roles`, h(async (_req, ctx) => {
    if (!ctx.roles.includes('admin')) throw new svc.HttpError(403, '只有管理員能看角色設定');
    return { rows: await S.listRoles(), all: ALL_ROLES.map((r) => ({ key: r, label: ROLE_LABEL[r] })) };
  }));
  app.put(`${API}/roles`, h(async (req, ctx) => {
    if (!ctx.roles.includes('admin')) throw new svc.HttpError(403, '只有管理員能改角色');
    const b = req.body as any;
    const email = String(b?.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@(popin\.cc|broadciel\.com)$/.test(email)) throw new svc.HttpError(400, '只能設定 @popin.cc／@broadciel.com 帳號');
    const roles = (Array.isArray(b?.roles) ? b.roles : []).filter((r: string) => ALL_ROLES.includes(r as Role)) as Role[];
    // 後端也擋：不能拿掉自己的管理員（審查 #17.7：原本只有前端 disabled，IOCUE_ADMINS 以外的管理員可能把自己鎖在外面）
    if (email === ctx.email && !roles.includes('admin') && !ADMINS.includes(email)) throw new svc.HttpError(400, '不能拿掉自己的管理員角色（請另一位管理員操作）');
    await S.tx(async (qq) => {
      await S.upsertRole(qq, email, String(b?.name ?? '').trim().slice(0, 64), roles, ctx.email);
      await S.audit(qq, { email: ctx.email, ip: ctx.ip, projectId: null, action: 'roles', target: email, detail: { roles } });
    });
    return { ok: true };
  }));
}
