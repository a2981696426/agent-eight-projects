import '@ant-design/v5-patch-for-react-19';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import relativeTime from 'dayjs/plugin/relativeTime';
import App from './App';
import { AuthProvider } from './auth';
import './styles.css';

dayjs.locale('zh-cn');
dayjs.extend(relativeTime);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }} theme={{ token: { colorPrimary: '#1f6feb', borderRadius: 6, fontFamily: '"PingFang SC","Microsoft YaHei","Helvetica Neue",Arial,sans-serif' } }}>
      <AntApp>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
