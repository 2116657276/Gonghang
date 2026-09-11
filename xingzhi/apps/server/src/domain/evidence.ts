import type { PlanSnapshot } from '@xingzhi/contracts';

export const evidenceSections = ['summary', 'orders', 'authorizations', 'aftercare', 'events', 'operations'] as const;
export type EvidenceSection = (typeof evidenceSections)[number];

export type EvidenceDocument = {
  title: string;
  version: 1;
  planId: string;
  generatedAt: string;
  expiresAt: string;
  sections: EvidenceSection[];
  summary?: {
    purpose: string;
    version: number;
    pausedItemIds: string[];
    items: PlanSnapshot['items'];
    budget: PlanSnapshot['budget'];
    pending: string[];
  };
  orders?: Array<Record<string, unknown>>;
  authorizations?: PlanSnapshot['authorizations'];
  aftercare?: PlanSnapshot['cancellations'];
  events?: Array<Record<string, unknown>>;
  operations?: Array<Record<string, unknown>>;
};

export function maskIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function isSensitiveKey(key: string) {
  return /private|secret|password|token|signature|rawbody|rawpayload/i.test(key);
}

export function sanitizeEvidence(value: unknown, key = ''): unknown {
  if (isSensitiveKey(key)) return undefined;
  if (typeof value === 'string' && /businessnumber|tradeno/i.test(key)) return maskIdentifier(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item, key)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .map(([entryKey, entryValue]) => [entryKey, sanitizeEvidence(entryValue, entryKey)])
      .filter(([, entryValue]) => entryValue !== undefined));
  }
  return value;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function renderEvidenceHtml(document: EvidenceDocument) {
  const body = escapeHtml(JSON.stringify(document, null, 2));
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>行止计划行迹 · ${escapeHtml(document.planId)}</title>
    <style>
      :root { color: #1d292b; background: #eef3f1; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
      body { max-width: 960px; margin: 0 auto; padding: 40px 24px; }
      main { background: #fbfcfa; border: 1px solid #d5e0db; padding: 28px; }
      h1 { color: #173f45; font: 500 30px/1.2 "Songti SC", STSong, serif; }
      p { color: #637776; line-height: 1.6; }
      pre { overflow: auto; padding: 18px; color: #173f45; background: #f1f6f3; border-left: 3px solid #d26d35; line-height: 1.55; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <main>
      <p>脱敏证据导出 · ${escapeHtml(document.generatedAt)}</p>
      <h1>行止计划行迹</h1>
      <p>此文件仅包含指定计划的业务事实与脱敏关联号，有效期至 ${escapeHtml(document.expiresAt)}。</p>
      <pre>${body}</pre>
    </main>
  </body>
</html>`;
}
