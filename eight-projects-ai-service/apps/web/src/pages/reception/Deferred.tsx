import { Card, Descriptions, Result, Tag } from 'antd';

export default function Deferred({ title, desc }: { title: string; desc: string }) {
  const plan: Record<string, { deps: string[]; reuse: string[] }> = {
    呼叫中心: { deps: ['SIP/云呼叫线路与号码资源', 'ASR/TTS 引擎', '坐席软电话与录音存储'], reuse: ['呼入机器人 IVR 流程与执行链', '子案件与 DMS 关联', '智能质检（通话文本）'] },
    视频客服: { deps: ['WebRTC 信令与媒体服务', '屏幕共享/远程标注', '录制合规存储'], reuse: ['在线客服工作台三栏布局', '会话小记与子案件生成', '客户 360'] },
  };
  const p = plan[title] ?? { deps: [], reuse: [] };
  return (
    <div className="page">
      <Card>
        <Result
          status="info"
          title={
            <>
              {title} <Tag>暂缓</Tag>
            </>
          }
          subTitle={`${desc}。本阶段按产品规划暂缓实现，导航与骨架已预留，接入时不改变其余模块。`}
        />
        <Descriptions bordered size="small" column={1} style={{ maxWidth: 820, margin: '0 auto' }}>
          <Descriptions.Item label="接入所需外部依赖">{p.deps.join('；')}</Descriptions.Item>
          <Descriptions.Item label="可直接复用的现有能力">{p.reuse.join('；')}</Descriptions.Item>
          <Descriptions.Item label="与执行链的关系">通道适配器只负责协议转换；意图识别、证据获取、风险分级与自治门禁复用同一条链，保证跨渠道一致。</Descriptions.Item>
        </Descriptions>
      </Card>
    </div>
  );
}
