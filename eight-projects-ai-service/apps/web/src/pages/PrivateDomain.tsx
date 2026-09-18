import { Card, Col, Row, Tag } from 'antd';
import { Link } from 'react-router-dom';

export default function PrivateDomain() {
  const items = [
    { name: 'AI 私域', desc: '赋能企微运营，提升私域价值', status: '规划' },
    { name: 'AI 外呼', desc: '多轮互动式 AI 外呼，比人更专业更高效', status: '复用', to: '/ai/outbound' },
    { name: 'SCRM', desc: '赋能销售获客转化', status: '规划' },
    { name: '企微私域数字员工', desc: 'AI 私域助理，赋能运营全链路', status: '规划' },
    { name: '门店导购数字员工', desc: '提升导购效率和专业度', status: '规划' },
    { name: 'AI 外呼数字员工', desc: '有温度、更智能、更懂人心', status: '复用', to: '/ai/outbound' },
  ];
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>AI 私域</h2>
          <div className="desc">对应网易云商顶部导航「AI 私域」。本期以 AI 客服为主线；私域模块沿用同一执行链与知识底座，此处为骨架占位与复用入口。</div>
        </div>
      </div>
      <Row gutter={[12, 12]}>
        {items.map((it) => (
          <Col key={it.name} xs={24} md={12} xl={8}>
            <Card size="small" title={it.name} extra={<Tag color={it.status === '复用' ? 'green' : 'default'}>{it.status}</Tag>}>
              <div style={{ color: '#6b7280', fontSize: 13 }}>{it.desc}</div>
              {it.to && (
                <div style={{ marginTop: 8 }}>
                  <Link to={it.to}>进入 →</Link>
                </div>
              )}
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
