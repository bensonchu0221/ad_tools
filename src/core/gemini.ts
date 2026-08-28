// Vertex AI Gemini 的薄封裝：用 ADC（無金鑰），與 bigquery.ts／gsheets.ts／gcs.ts 同一套認證。
//
// 為什麼走 Vertex 而不是 Gemini API（generativelanguage）金鑰：
//  - 線上 Cloud Run SA `439393162392-compute@…` **已經有 roles/aiplatform.user**（2026-08-28 查證），
//    走 ADC 就不必新增 API key、不必多一個 Secret，也不會有金鑰外流問題。
//  - `aiplatform.googleapis.com` 在 popinpoc1 已啟用。
//
// ⚠️ scope 一律 `cloud-platform`（gcpwatch tool#4 上線首發那個坑：本機 gcloud 使用者憑證會忽略
//    程式指定的 scope，只有 Cloud Run 的 SA token 才照 scope 發 ⇒ scope 開太小只有部署後才看得到）。
//
// ⚠️ region：**Gemini 不在 asia-east1**（2026-08-28 實測回 404
//    "Publisher model … was not found or your project does not have access to it"）。
//    `global` 與 `us-central1` 實測 200，預設用 global。
import { google } from 'googleapis';

export const GEMINI_PROJECT = process.env.GEMINI_PROJECT_ID ?? process.env.BQ_PROJECT_ID ?? 'popinpoc1';
export const GEMINI_LOCATION = process.env.GEMINI_LOCATION ?? 'global';
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

/** global 沒有 region 前綴，其它 region 有。 */
export function geminiEndpoint(project = GEMINI_PROJECT, location = GEMINI_LOCATION, model = GEMINI_MODEL): string {
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

/** 回應可能有多個 part（也可能因為 MAX_TOKENS 被截斷），一律接起來。 */
export function extractText(body: any): string {
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: any) => String(p?.text ?? '')).join('').trim();
}

let auth: InstanceType<typeof google.auth.GoogleAuth> | null = null;

async function accessToken(): Promise<string> {
  if (!auth) auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const c = await auth.getClient();
  const t = await c.getAccessToken();
  const token = typeof t === 'string' ? t : t?.token;
  if (!token) throw new Error('取不到 Google access token（ADC 未設定？）');
  return token;
}

export interface GenerateOptions {
  maxOutputTokens?: number;
  temperature?: number;
  /** 預設關掉 thinking：使用者站在那邊等 Siri 唸，延遲比推理深度重要（實測關掉約 1.4s）。 */
  thinkingBudget?: number;
  timeoutMs?: number;
  systemInstruction?: string;
}

/** 送一段 prompt 拿一段文字。失敗一律丟錯，呼叫端自己決定要不要降級。 */
export async function generateText(prompt: string, opts: GenerateOptions = {}): Promise<string> {
  const token = await accessToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25_000);
  try {
    const res = await fetch(geminiEndpoint(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        ...(opts.systemInstruction ? { systemInstruction: { parts: [{ text: opts.systemInstruction }] } } : {}),
        generationConfig: {
          maxOutputTokens: opts.maxOutputTokens ?? 512,
          temperature: opts.temperature ?? 0.4,
          thinkingConfig: { thinkingBudget: opts.thinkingBudget ?? 0 },
        },
      }),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${body?.error?.message ?? '(no body)'}`);
    const text = extractText(body);
    if (!text) throw new Error(`Gemini 回空內容（finishReason=${body?.candidates?.[0]?.finishReason ?? '?'}）`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}
