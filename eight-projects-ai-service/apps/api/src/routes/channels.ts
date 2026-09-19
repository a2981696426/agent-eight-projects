import type { FastifyInstance } from 'fastify';
import { J, nowIso, openDb, uid } from '../db.ts';
import { channelStatus, registerChannel } from '../services/channels.ts';
import { enqueueInbound, jobsStatus } from '../services/jobs.ts';
import { decryptMessage, parseWechatXml, readXml, verifyMsgSignature, verifySignature, wechatAdapter } from '../channels/wechat.ts';

/**
 * 渠道 Webhook 与状态。
 * 微信：GET 校验回 echostr；POST 校验签名 →（安全模式解密）→ 归一化 → 入队 → 立即回 "success"（5 秒约束）。
 * 解析不出的消息类型也回 success（避免微信重试轰炸），但写审计。
 */
const audit = (action: string, target: string, detail: unknown = null) => openDb().run('INSERT INTO audit_log VALUES (?,?,?,?,?,?)', uid('al-'), nowIso(), 'wechat', action, target, J.str(detail));

export async function channelRoutes(app: FastifyInstance) {
  registerChannel(wechatAdapter);
  // 微信以 text/xml 推送；Fastify 默认不解析该类型，这里按原文接收
  app.addContentTypeParser(['text/xml', 'application/xml'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.get('/api/channels/wechat/webhook', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!verifySignature(wechatAdapter.cfg.token, q.timestamp ?? '', q.nonce ?? '', q.signature ?? '')) return reply.code(403).send('signature mismatch');
    return reply.type('text/plain').send(q.echostr ?? '');
  });

  app.post('/api/channels/wechat/webhook', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (!verifySignature(wechatAdapter.cfg.token, q.timestamp ?? '', q.nonce ?? '', q.signature ?? '')) return reply.code(403).send('signature mismatch');
    let xml = typeof req.body === 'string' ? req.body : '';
    if (q.encrypt_type === 'aes') {
      const outer = readXml(xml);
      const enc = outer?.Encrypt ? String(outer.Encrypt) : '';
      if (!enc || !verifyMsgSignature(wechatAdapter.cfg.token, q.timestamp ?? '', q.nonce ?? '', enc, q.msg_signature ?? '')) return reply.code(403).send('msg_signature mismatch');
      try {
        const dec = decryptMessage(wechatAdapter.cfg.aesKey, enc);
        if (wechatAdapter.cfg.appId && dec.appId !== wechatAdapter.cfg.appId) return reply.code(403).send('appid mismatch');
        xml = dec.xml;
      } catch (e) {
        await audit('wechat.decrypt_failed', 'webhook', { error: (e as Error).message });
        return reply.type('text/plain').send('success');
      }
    }
    const msg = parseWechatXml(xml);
    if (!msg) {
      await audit('wechat.unsupported_message', 'webhook', { snippet: xml.slice(0, 200) });
      return reply.type('text/plain').send('success');
    }
    // 先入队再 ack：5 秒内响应，处理由 channel.inbound worker 完成
    enqueueInbound(msg).catch((e) => audit('wechat.enqueue_failed', msg.externalMsgId, { error: (e as Error).message }));
    return reply.type('text/plain').send('success');
  });

  app.get('/api/channels/status', async () => ({ adapters: await channelStatus(), jobs: jobsStatus(), wechat: { configured: wechatAdapter.configured, mock: wechatAdapter.cfg.mock, webhook: '/api/channels/wechat/webhook' } }));
  app.get('/api/channels/wechat/mock/sent', async () => ({ mode: (await wechatAdapter.health()).mode, sent: [...wechatAdapter.mockSent].reverse().slice(0, 100) }));
}
