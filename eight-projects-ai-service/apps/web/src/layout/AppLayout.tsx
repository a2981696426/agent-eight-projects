import { Dropdown, Layout, Menu, Tag, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import {
  ApiOutlined,
  LogoutOutlined,
  UserOutlined,
  AudioOutlined,
  BarChartOutlined,
  BulbOutlined,
  CustomerServiceOutlined,
  DashboardOutlined,
  DeploymentUnitOutlined,
  ExperimentOutlined,
  FileSearchOutlined,
  FundProjectionScreenOutlined,
  MessageOutlined,
  PhoneOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SolutionOutlined,
  SoundOutlined,
  TeamOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useApi } from '../api';
import { useAuth } from '../auth';

const { Header, Sider, Content } = Layout;

export const NAV: { group: string; items: { key: string; label: string; icon: React.ReactNode; deferred?: boolean }[] }[] = [
  {
    group: '系统基座 · 服务接待',
    items: [
      { key: '/reception/online', label: '在线客服', icon: <CustomerServiceOutlined /> },
      { key: '/reception/call-center', label: '呼叫中心', icon: <PhoneOutlined />, deferred: true },
      { key: '/reception/video', label: '视频客服', icon: <VideoCameraOutlined />, deferred: true },
      { key: '/reception/tickets', label: '工单系统', icon: <SolutionOutlined /> },
    ],
  },
  {
    group: '智能增强',
    items: [
      { key: '/ai/online-robot', label: '在线机器人', icon: <RobotOutlined /> },
      { key: '/ai/inbound-robot', label: '呼入机器人', icon: <AudioOutlined /> },
      { key: '/ai/outbound', label: 'AI 外呼', icon: <SoundOutlined /> },
      { key: '/ai/aigc', label: 'AIGC 应用', icon: <BulbOutlined /> },
      { key: '/ai/agent-studio', label: 'Agent Studio', icon: <ExperimentOutlined /> },
      { key: '/ai/mind-studio', label: 'Mind Studio', icon: <DeploymentUnitOutlined /> },
    ],
  },
  {
    group: '服务管理',
    items: [
      { key: '/management/quality', label: '智能质检', icon: <SafetyCertificateOutlined /> },
      { key: '/management/reports', label: '自定义报表', icon: <BarChartOutlined /> },
      { key: '/management/dashboard', label: '数据大屏', icon: <FundProjectionScreenOutlined /> },
      { key: '/management/voc', label: '客户之声', icon: <FileSearchOutlined /> },
    ],
  },
  {
    group: '智能体 · 售后服务数字员工',
    items: [{ key: '/employees', label: '数字员工', icon: <TeamOutlined /> }],
  },
];

export default function AppLayout() {
  const loc = useLocation();
  const nav = useNavigate();
  const { user, roles, logout } = useAuth();
  const { data: health } = useApi<{ llm: { configured: boolean; modelFast: string }; knowledgeIndexed: number }>('/api/health', { pollMs: 30_000 });
  const items: MenuProps['items'] = [
    { key: '/', icon: <DashboardOutlined />, label: <Link to="/">总览</Link> },
    ...NAV.map((g) => ({
      type: 'group' as const,
      label: g.group,
      children: g.items.map((it) => ({
        key: it.key,
        icon: it.icon,
        label: (
          <Link to={it.key}>
            {it.label}
            {it.deferred && (
              <Tag style={{ marginLeft: 6, fontSize: 10, lineHeight: '16px', padding: '0 4px' }} color="default">
                暂缓
              </Tag>
            )}
          </Link>
        ),
      })),
    })),
  ];
  const selected = items.flatMap((i: any) => (i?.children ? i.children.map((c: any) => c.key) : [i?.key])).find((k: string) => k !== '/' && loc.pathname.startsWith(k)) ?? '/';
  const isPrivateDomain = loc.pathname.startsWith('/private-domain');
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ background: '#0f1f3d', padding: '0 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 52 }}>
        <div className="top-nav">
          <Link to="/" className="brand">
            <span className="dot" />
            八项目 · AI 客服
          </Link>
          <Link to="/" className={`tab ${!isPrivateDomain ? 'active' : ''}`}>
            AI 客服
          </Link>
          <Link to="/private-domain" className={`tab ${isPrivateDomain ? 'active' : ''}`}>
            AI 私域
          </Link>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: '#cbd5e1', fontSize: 12 }}>
          <Tooltip title="大模型连接状态（兼容 OpenAI 协议）">
            <Tag color={health?.llm.configured ? 'green' : 'red'} icon={<ApiOutlined />}>
              {health ? (health.llm.configured ? `LLM · ${health.llm.modelFast}` : 'LLM 不可用 · 规则降级') : '连接中…'}
            </Tag>
          </Tooltip>
          <Tag icon={<MessageOutlined />} color="blue">
            知识块 {health?.knowledgeIndexed ?? '—'}
          </Tag>
          <Dropdown
            menu={{
              items: [
                { key: 'role', label: `角色：${user ? roles[user.role] : '—'}`, disabled: true },
                { key: 'visitor', label: <a href="/visitor" target="_blank" rel="noreferrer">打开独立访客端</a> },
                { type: 'divider' },
                { key: 'logout', label: '退出登录', icon: <LogoutOutlined />, onClick: () => logout().then(() => nav('/login')) },
              ],
            }}
          >
            <span style={{ cursor: 'pointer', color: '#fff' }}>
              <UserOutlined /> {user?.name ?? '未登录'} · 欧态旗舰店
            </span>
          </Dropdown>
        </div>
      </Header>
      <Layout>
        <Sider width={220} theme="light" style={{ borderRight: '1px solid #eef0f3', overflow: 'auto', height: 'calc(100vh - 52px)', position: 'sticky', top: 52 }}>
          <Menu mode="inline" selectedKeys={[selected]} items={items} style={{ borderRight: 0, paddingBottom: 24 }} />
        </Sider>
        <Content style={{ minWidth: 0 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
