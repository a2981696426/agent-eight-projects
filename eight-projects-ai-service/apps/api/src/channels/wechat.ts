import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { InboundMessage, SendResult } from '@eight/shared';
import type { ChannelAdapter } from '../services/channels.ts';

/**
 * 微信公众号（含测试号）渠道适配器：
 * - 服务器地址校验：sha1(sort(token, timestamp, nonce)) === signature，回 echostr
 * - 消息推送：明文 XML 或安全模式（encrypt_type=aes，AES-256-CBC，EncodingAESKey 43 位）
 * - 5 秒内必须响应：路由先回 "success"，处理走队列；所有回复经客服消息接口异步发送
 * - 48 小时互动窗口：errcode 45015 → window_expired（不可重试）；45047 → rate_limited
 * WECHAT_MOCK=1 或未配置 AppID 时不出网，发送记录在 mockSent 供本机/e2e 使用。
 */
export interface WechatConfig {
  appId: string;
  secret: string;
  token: string;
  aesKey: string;
  mock: boolean;
  apiBase?: string;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
export function verifySignature(token: string, timestamp: string, nonce: string, signature: string): boolean {
  if (!token || !timestamp || !nonce || !signature) return false;
  return sha1([token, timestamp, nonce].sort().join('')) === signature.toLowerCase();
}
export function verifyMsgSignature(token: string, timestamp: string, nonce: string, encrypt: string, msgSignature: string): boolean {
  if (!token || !timestamp || !nonce || !encrypt || !msgSignature) return false;
  return sha1([token, timestamp, nonce, encrypt].sort().join('')) === msgSignature.toLowerCase();
}

const aesKeyBytes = (encodingAesKey: string) => Buffer.from(`${encodingAesKey}=`, 'base64');

/** 安全模式解密：random(16) + msgLen(4, BE) + msg + appId，PKCS#7（块 32） */
export function decryptMessage(encodingAesKey: string, encrypted: string): { xml: string; appId: string } {
  const key = aesKeyBytes(encodingAesKey);
  if (key.length !== 32) throw new Error('EncodingAESKey 无效（应为 43 位）');
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  const buf = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  const pad = buf[buf.length - 1];
  const content = buf.subarray(0, buf.length - (pad >= 1 && pad <= 32 ? pad : 0));
  const len = content.readUInt32BE(16);
  const xml = content.subarray(20, 20 + len).toString('utf8');
  const appId = content.subarray(20 + len).toString('utf8');
  return { xml, appId };
}
/** 测试与被动回复用：与 decryptMessage 互逆 */
export function encryptMessage(encodingAesKey: string, xml: string, appId: string): string {
  const key = aesKeyBytes(encodingAesKey);
  const msg = Buffer.from(xml, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length, 0);
  const raw = Buffer.concat([randomBytes(16), len, msg, Buffer.from(appId, 'utf8')]);
  const padLen = 32 - (raw.length % 32 || 32);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen === 0 ? 32 : padLen, padLen === 0 ? 32 : padLen)]);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

const parser = new XMLParser({ ignoreAttributes: true, cdataPropName: false, parseTagValue: false, trimValues: true });
type WxXml = Partial<Record<'ToUserName' | 'FromUserName' | 'CreateTime' | 'MsgType' | 'Content' | 'MsgId' | 'PicUrl' | 'MediaId' | 'Event' | 'EventKey' | 'Encrypt', string>>;

export function readXml(body: string): WxXml | null {
  try {
    const doc = parser.parse(body) as { xml?: WxXml };
    return doc?.xml && typeof doc.xml === 'object' ? doc.xml : null;
  } catch {
    return null;
  }
}

/** 归一化为入站消息；不支持的类型返回 null（路由仍回 success） */
export function parseWechatXml(body: string): InboundMessage | null {
  const x = readXml(body);
  if (!x?.FromUserName || !x.MsgType) return null;
  const receivedAt = x.CreateTime ? new Date(Number(x.CreateTime) * 1000).toISOString() : new Date().toISOString();
  const base = { channel: 'wechat' as const, externalUserId: String(x.FromUserName), receivedAt, attachments: [] as InboundMessage['attachments'] };
  switch (String(x.MsgType)) {
    case 'text':
      return { ...base, externalMsgId: String(x.MsgId ?? `${x.FromUserName}-${x.CreateTime}`), kind: 'text', text: String(x.Content ?? '').trim() };
    case 'image':
      return { ...base, externalMsgId: String(x.MsgId ?? `${x.FromUserName}-${x.CreateTime}`), kind: 'image', text: '', attachments: [{ type: 'image', mediaId: x.MediaId ? String(x.MediaId) : undefined, url: x.PicUrl ? String(x.PicUrl) : undefined }] };
    case 'event': {
      const ev = String(x.Event ?? '').toLowerCase();
      if (ev !== 'subscribe') return null;
      return { ...base, externalMsgId: `evt-${x.FromUserName}-${x.CreateTime ?? Date.now()}-${ev}`, kind: 'event', text: `[${ev}]` };
    }
    default:
      return null;
  }
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

export class WechatAdapter implements ChannelAdapter {
  readonly channel = 'wechat' as const;
  readonly capabilities = { asyncReply: true, media: true, windowHours: 48 };
  readonly mockSent: { to: string; text: string; at: string }[] = [];
  private tokenCache: TokenCache | null = null;
  constructor(readonly cfg: WechatConfig) {}

  get configured() {
    return !!(this.cfg.appId && this.cfg.secret && this.cfg.token);
  }
  private get apiBase() {
    return this.cfg.apiBase ?? 'https://api.weixin.qq.com';
  }

  async getAccessToken(force = false): Promise<string> {
    if (!force && this.tokenCache && this.tokenCache.expiresAt - 60_000 > Date.now()) return this.tokenCache.token;
    const res = await fetch(`${this.apiBase}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(this.cfg.appId)}&secret=${encodeURIComponent(this.cfg.secret)}`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    if (!j.access_token) throw new Error(`获取 access_token 失败：${j.errcode ?? res.status} ${j.errmsg ?? ''}`);
    this.tokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 7200) * 1000 };
    return j.access_token;
  }

  async send(openid: string, text: string): Promise<SendResult> {
    if (this.cfg.mock || !this.configured) {
      const at = new Date().toISOString();
      this.mockSent.push({ to: openid, text, at });
      if (this.mockSent.length > 500) this.mockSent.splice(0, this.mockSent.length - 500);
      return { ok: true, externalMsgId: `mock-${this.mockSent.length}` };
    }
    const attempt = async (force: boolean): Promise<SendResult & { refresh?: boolean }> => {
      let token: string;
      try {
        token = await this.getAccessToken(force);
      } catch (e) {
        return { ok: false, kind: 'unavailable', message: (e as Error).message, retryable: true };
      }
      let res: Response;
      try {
        res = await fetch(`${this.apiBase}/cgi-bin/message/custom/send?access_token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ touser: openid, msgtype: 'text', text: { content: text } }), signal: AbortSignal.timeout(8000) });
      } catch (e) {
        return { ok: false, kind: 'unavailable', message: `微信接口网络错误：${(e as Error).message}`, retryable: true };
      }
      const j = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string; msgid?: number };
      const code = j.errcode ?? 0;
      if (code === 0) return { ok: true, externalMsgId: j.msgid != null ? String(j.msgid) : null };
      if (code === 40001 || code === 42001 || code === 40014) return { ok: false, kind: 'unavailable', message: `access_token 失效（${code}）`, retryable: true, refresh: true };
      if (code === 45015) return { ok: false, kind: 'window_expired', message: `45015 超出 48 小时互动窗口：${j.errmsg ?? ''}`, retryable: false };
      if (code === 45047) return { ok: false, kind: 'rate_limited', message: `45047 客服消息条数超限：${j.errmsg ?? ''}`, retryable: false };
      if (code === 45009 || code === 45011) return { ok: false, kind: 'rate_limited', message: `${code} 接口调用超限：${j.errmsg ?? ''}`, retryable: true };
      if (code >= 500 || code === -1) return { ok: false, kind: 'unavailable', message: `微信系统繁忙（${code}）：${j.errmsg ?? ''}`, retryable: true };
      return { ok: false, kind: 'rejected', message: `微信拒绝（${code}）：${j.errmsg ?? ''}`, retryable: false };
    };
    const first = await attempt(false);
    if (!first.ok && first.refresh) {
      const { refresh: _r, ...second } = await attempt(true);
      return second;
    }
    const { refresh: _r, ...out } = first;
    return out;
  }

  async health() {
    return { ok: true, mode: this.cfg.mock || !this.configured ? 'mock' : 'live' };
  }
}

export const wechatConfigFromEnv = (): WechatConfig => ({
  appId: process.env.WECHAT_APPID ?? '',
  secret: process.env.WECHAT_SECRET ?? '',
  token: process.env.WECHAT_TOKEN ?? '',
  aesKey: process.env.WECHAT_AES_KEY ?? '',
  mock: process.env.WECHAT_MOCK === '1' || !process.env.WECHAT_APPID || !process.env.WECHAT_SECRET,
});

export const wechatAdapter = new WechatAdapter(wechatConfigFromEnv());
