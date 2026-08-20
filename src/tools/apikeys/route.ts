// 對外 API key 管理頁（內部工具，受 Google OAuth 保護——不要加進 auth.ts 白名單）。
// 明文 key 只在建立當下顯示一次，DB 只存 sha256，之後任何人都無法還原。
import type { FastifyInstance } from 'fastify';
import { sbPage } from '../../core/sbui.js';
import { currentUser } from '../../core/auth.js';
import {
  listApiClients, createApiClient, updateApiClient, deleteApiClient, setApiClientScopes,
  type ApiClientRow,
} from '../../core/store.js';

export const BASE_PATH = '/tools/apikeys';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function noticePage(msg: string): string {
  return sbPage({
    title: 'API Key 管理 · 錯誤',
    body: `
    <div class="crumb"><a href="/">// tools</a> / apikeys</div>
    <div class="msg msg-err" style="margin-top:40px">${esc(msg)}</div>
    <a class="btn-line" style="display:inline-block;margin-top:18px" href="${BASE_PATH}">← 返回</a>`,
  });
}

function clientRows(rows: ApiClientRow[]): string {
  if (!rows.length) return '<tr><td colspan="6">尚未建立任何 API key</td></tr>';
  return rows
    .map((c) => {
      const advertisers = c.scopes.filter((s) => s.platform === 'P').map((s) => s.advertiserId);
      const statusPill = c.status === 'active'
        ? '<span class="src-pill prot">啟用中</span>'
        : '<span class="src-pill mir">已停用</span>';
      return `<tr>
        <td>${esc(c.clientName)}</td>
        <td>${statusPill}</td>
        <td>${c.rateLimitPerMin} / 分</td>
        <td>${advertisers.length ? esc(advertisers.join(', ')) : '<em>未設定（無法查詢）</em>'}</td>
        <td>${esc(c.createdBy ?? '')}<br><small>${esc(c.createdAt)}</small></td>
        <td>
          <form method="post" action="${BASE_PATH}/${c.id}/scopes" style="margin-bottom:6px">
            <textarea name="advertiser_ids" rows="2" placeholder="一行一個廣告主 ID">${esc(advertisers.join('\n'))}</textarea>
            <button class="btn-line" type="submit">儲存授權</button>
          </form>
          <form method="post" action="${BASE_PATH}/${c.id}/status" style="display:inline">
            <input type="hidden" name="status" value="${c.status === 'active' ? 'disabled' : 'active'}">
            <button class="btn-line" type="submit">${c.status === 'active' ? '停用' : '啟用'}</button>
          </form>
          <form method="post" action="${BASE_PATH}/${c.id}/delete" style="display:inline"
                onsubmit="return confirm('刪除後這把 key 立刻失效，且無法復原。確定？')">
            <button class="btn-line" type="submit">刪除</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');
}

function page(rows: ApiClientRow[], newKey?: string): string {
  // 新建立的 key 只在這一次的頁面呈現；重新整理就不見了
  const keyBanner = newKey
    ? `<div class="msg msg-ok" style="margin-top:24px">
         <b>已建立。請立刻複製保存，關閉後無法再查看：</b>
         <div class="keybox">${esc(newKey)}</div>
       </div>`
    : '';
  return sbPage({
    title: 'API Key 管理',
    // src-pill／prot／mir 是頁面級 CSS（sbui.ts 沒有，tokens 頁也是自己定義的），要從這裡帶進去
    style: `
      .src-pill{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;
        padding:2px 8px;border:1px solid currentColor;border-radius:2px}
      .src-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
      .src-pill.prot{color:var(--ok);border-color:var(--ok)}
      .src-pill.mir{color:var(--slate)}
      .keybox{font-family:var(--mono);font-size:15px;user-select:all;margin-top:8px;word-break:break-all}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
      textarea{width:100%;font-family:var(--mono);font-size:12px}`,
    body: `
    <div class="crumb"><a href="/">// tools</a> / apikeys</div>
    <h1>對外 API Key</h1>
    <p>核發給外部客戶呼叫 <code>/api/v1</code> 的金鑰。授權廣告主為空的 key 無法查詢任何資料。</p>
    ${keyBanner}
    <form method="post" action="${BASE_PATH}/create" style="margin:24px 0">
      <input name="client_name" placeholder="客戶名稱" required>
      <input name="rate_limit_per_min" type="number" value="60" min="1" max="10000" style="width:120px">
      <button class="btn-line" type="submit">核發新 key</button>
    </form>
    <table>
      <thead><tr><th>客戶</th><th>狀態</th><th>速率上限</th><th>授權廣告主</th><th>建立</th><th>操作</th></tr></thead>
      <tbody>${clientRows(rows)}</tbody>
    </table>`,
  });
}

export async function registerApiKeys(app: FastifyInstance): Promise<void> {
  app.get(BASE_PATH, async (req, reply) => {
    const newKey = (req.query as any)?.new_key as string | undefined;
    try {
      reply.type('text/html').send(page(await listApiClients(), newKey));
    } catch (e: any) {
      reply.type('text/html').send(noticePage(String(e?.message ?? e)));
    }
  });

  app.post(`${BASE_PATH}/create`, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const clientName = (b.client_name ?? '').trim();
    if (!clientName) return reply.type('text/html').send(noticePage('客戶名稱必填'));
    const rate = Number(b.rate_limit_per_min ?? 60);
    try {
      // 建立者取自登入身分，不信任表單傳來的值
      const created = await createApiClient({
        clientName,
        rateLimitPerMin: Number.isFinite(rate) && rate > 0 ? Math.floor(rate) : 60,
        createdBy: currentUser(req) ?? null,
      });
      // 明文 key 只透過這一次 redirect 呈現，不寫入任何持久化位置
      reply.redirect(`${BASE_PATH}?new_key=${encodeURIComponent(created.plainKey)}`);
    } catch (e: any) {
      reply.type('text/html').send(noticePage(String(e?.message ?? e)));
    }
  });

  app.post(`${BASE_PATH}/:id/scopes`, async (req, reply) => {
    const id = Number((req.params as any).id);
    const raw = ((req.body as any)?.advertiser_ids ?? '') as string;
    const ids = raw.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
    try {
      await setApiClientScopes(id, ids.map((advertiserId) => ({ platform: 'P' as const, advertiserId })));
      reply.redirect(BASE_PATH);
    } catch (e: any) {
      reply.type('text/html').send(noticePage(String(e?.message ?? e)));
    }
  });

  app.post(`${BASE_PATH}/:id/status`, async (req, reply) => {
    const id = Number((req.params as any).id);
    const status = (req.body as any)?.status === 'active' ? 'active' : 'disabled';
    try {
      await updateApiClient(id, { status });
      reply.redirect(BASE_PATH);
    } catch (e: any) {
      reply.type('text/html').send(noticePage(String(e?.message ?? e)));
    }
  });

  app.post(`${BASE_PATH}/:id/delete`, async (req, reply) => {
    const id = Number((req.params as any).id);
    try {
      await deleteApiClient(id);
      reply.redirect(BASE_PATH);
    } catch (e: any) {
      reply.type('text/html').send(noticePage(String(e?.message ?? e)));
    }
  });
}
