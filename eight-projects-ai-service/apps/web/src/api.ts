import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: unknown) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `请求失败 HTTP ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

/** 简易数据钩子：自动加载、手动刷新、可选轮询 */
export function useApi<T>(path: string | null, opts: { pollMs?: number; deps?: unknown[] } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    void load();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (opts.pollMs) timer = setInterval(() => void load(), opts.pollMs);
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, opts.pollMs, ...(opts.deps ?? [])]);
  return { data, loading, error, reload: load, setData };
}

export interface StageProgress {
  id: string;
  label: string;
  status: 'ok' | 'skipped' | 'error';
  durationMs: number;
  summary: string;
}

/**
 * 以 SSE 流式发送用户消息：逐阶段回调进度，最终返回与非流式接口相同的结果。
 * POST 不能用 EventSource，这里用 fetch + ReadableStream 手动解析 event/data 帧。
 */
export async function streamChat<T = unknown>(conversationId: string, text: string, onStage: (s: StageProgress) => void): Promise<T> {
  const res = await fetch(`/api/conversations/${conversationId}/messages/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'user', text }) });
  if (!res.ok || !res.body) {
    const t = await res.text();
    let msg = `请求失败 HTTP ${res.status}`;
    try {
      msg = (JSON.parse(t) as { error?: string }).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status, t);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done: T | null = null;
  let error: string | null = null;
  const handle = (frame: string) => {
    const lines = frame.split('\n');
    const event = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!event || !data) return;
    const payload = JSON.parse(data);
    if (event === 'stage') onStage(payload as StageProgress);
    else if (event === 'done') done = payload as T;
    else if (event === 'error') error = (payload as { error: string }).error;
  };
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.trim() && !frame.startsWith(':')) handle(frame);
    }
  }
  if (buffer.trim()) handle(buffer);
  if (error) throw new ApiError(error, 500, null);
  if (!done) throw new ApiError('流式响应未返回结果', 500, null);
  return done;
}

export const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
export const fmtShort = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—');
export const pct = (v: number | null | undefined, digits = 0) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`);
