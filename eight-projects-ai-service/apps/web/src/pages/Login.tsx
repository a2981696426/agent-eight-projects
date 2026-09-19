import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Tag, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

export default function Login() {
  const { user, login, demo, roles } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const next = (loc.state as { from?: string } | null)?.from ?? '/';
  if (user) return <Navigate to={next} replace />;

  async function submit(v: { username: string; password: string }) {
    setBusy(true);
    setError(null);
    try {
      await login(v.username, v.password);
      nav(next, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="visitor-bg">
      <Card style={{ width: 420, boxShadow: '0 20px 60px rgba(15,31,61,.15)' }}>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>八项目 · AI 客服</div>
          <Typography.Text type="secondary">服务营销一体化工作台 · 登录</Typography.Text>
        </div>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ username: 'admin', password: 'admin123' }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input prefix={<UserOutlined />} autoComplete="username" /></Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}><Input.Password prefix={<LockOutlined />} autoComplete="current-password" /></Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>登录</Button>
        </Form>
        <div style={{ marginTop: 16, fontSize: 12, color: '#6b7280' }}>
          演示账号（点击填入）：
          {demo.map((d) => (
            <div key={d.username} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', cursor: 'pointer' }} onClick={() => form.setFieldsValue({ username: d.username, password: d.password })}>
              <span><Tag>{roles[d.role]}</Tag>{d.name}</span>
              <span className="mono">{d.username} / {d.password}</span>
            </div>
          ))}
          <div style={{ marginTop: 10 }}>客户视角无需登录：<Link to="/visitor">独立访客端 →</Link></div>
        </div>
      </Card>
    </div>
  );
}
