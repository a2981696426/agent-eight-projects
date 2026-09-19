/**
 * 知识导入：FAQ CSV / JSON（含云商知识库导出的中文表头映射）→ 文档草稿。
 * 相似问写入正文（Q：…）以提升词法与语义召回；答案原文不改写。
 */
export type ImportFormat = 'text' | 'faq-csv' | 'faq-json';

export interface FaqItem {
  question: string;
  answer: string;
  similar: string[];
  category: string;
  tags: string[];
}

const HEADER_MAP: Record<string, keyof FaqItem> = {
  标准问: 'question', 问题: 'question', 标准问题: 'question', question: 'question', q: 'question', title: 'question',
  答案: 'answer', 回答: 'answer', 标准答案: 'answer', answer: 'answer', a: 'answer', content: 'answer',
  相似问: 'similar', 相似问题: 'similar', 扩展问: 'similar', similar: 'similar', similars: 'similar', aliases: 'similar',
  分类: 'category', 类目: 'category', 目录: 'category', category: 'category',
  标签: 'tags', tags: 'tags', tag: 'tags',
};

const splitList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (v == null) return [];
  return String(v).split(/[|;；\n]+|,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
};
const splitTags = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (v == null) return [];
  return String(v).split(/[\s,，;；|]+/).map((s) => s.trim()).filter(Boolean);
};

/** RFC4180 风格 CSV：支持引号、引号内逗号/换行、"" 转义；去 BOM */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

function normalizeItem(raw: Record<string, unknown>): FaqItem | null {
  const item: Partial<Record<keyof FaqItem, unknown>> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = HEADER_MAP[k.trim().toLowerCase()] ?? HEADER_MAP[k.trim()];
    if (key) item[key] = v;
  }
  const question = String(item.question ?? '').trim();
  const answer = String(item.answer ?? '').trim();
  if (!question || !answer) return null;
  return { question, answer, similar: splitList(item.similar), category: String(item.category ?? '').trim() || 'FAQ', tags: splitTags(item.tags) };
}

export function parseFaqCsv(csv: string): FaqItem[] {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  const out: FaqItem[] = [];
  for (const r of rows.slice(1)) {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => (obj[h] = r[i] ?? ''));
    const item = normalizeItem(obj);
    if (item) out.push(item);
  }
  return out;
}

export function parseFaqJson(json: string): FaqItem[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw Object.assign(new Error('JSON 解析失败：应为对象数组或 { items: [...] }'), { status: 400 });
  }
  const arr = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown[] })?.items) ? (data as { items: unknown[] }).items : null;
  if (!arr) throw Object.assign(new Error('JSON 需为数组或 { items: 数组 }'), { status: 400 });
  return arr.map((x) => (x && typeof x === 'object' ? normalizeItem(x as Record<string, unknown>) : null)).filter((x): x is FaqItem => !!x);
}

export function faqToDoc(item: FaqItem): { title: string; category: string; tags: string[]; content: string } {
  const lines = [`Q：${item.question}`, ...item.similar.map((s) => `Q：${s}`), `A：${item.answer}`];
  return { title: item.question.slice(0, 80), category: item.category || 'FAQ', tags: [...new Set([...item.tags, 'FAQ'])], content: lines.join('\n') };
}
