// 共用 HTML layout：全站 UI 統一使用 daisyUI（官方 CDN，無 build step）
// https://daisyui.com/docs/cdn/

export function layout(title: string, body: string, opts: { nav?: boolean } = { nav: true }): string {
  const nav = opts.nav === false ? '' : `
  <div class="navbar bg-base-100 shadow-sm">
    <div class="flex-1">
      <a href="/" class="btn btn-ghost text-lg">內部廣告工具系統</a>
    </div>
    <div class="flex-none">
      <a href="/logout" class="btn btn-ghost btn-sm">登出</a>
    </div>
  </div>`;

  return `<!doctype html>
<html lang="zh-Hant" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@5" rel="stylesheet" type="text/css" />
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
</head>
<body class="min-h-screen bg-base-200">
${nav}
<main class="max-w-3xl mx-auto p-4">
${body}
</main>
</body>
</html>`;
}
