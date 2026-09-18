import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './layout/AppLayout';
import Overview from './pages/Overview';
import OnlineService from './pages/reception/OnlineService';
import Tickets from './pages/reception/Tickets';
import Deferred from './pages/reception/Deferred';
import OnlineRobot from './pages/ai/OnlineRobot';
import InboundRobot from './pages/ai/InboundRobot';
import Outbound from './pages/ai/Outbound';
import Aigc from './pages/ai/Aigc';
import AgentStudio from './pages/ai/AgentStudio';
import MindStudio from './pages/ai/MindStudio';
import Quality from './pages/management/Quality';
import Reports from './pages/management/Reports';
import Dashboard from './pages/management/Dashboard';
import Voc from './pages/management/Voc';
import DigitalEmployees from './pages/employees/DigitalEmployees';
import PrivateDomain from './pages/PrivateDomain';
import Visitor from './pages/Visitor';

export default function App() {
  return (
    <Routes>
      <Route path="/management/dashboard" element={<Dashboard />} />
      <Route path="/visitor" element={<Visitor />} />
      <Route path="/visitor/:id" element={<Visitor />} />
      <Route element={<AppLayout />}>
        <Route index element={<Overview />} />
        <Route path="/reception/online" element={<OnlineService />} />
        <Route path="/reception/call-center" element={<Deferred title="呼叫中心" desc="安全稳定更贴心的云呼叫系统" />} />
        <Route path="/reception/video" element={<Deferred title="视频客服" desc="多渠道、面对面实时在线沟通" />} />
        <Route path="/reception/tickets" element={<Tickets />} />
        <Route path="/ai/online-robot" element={<OnlineRobot />} />
        <Route path="/ai/inbound-robot" element={<InboundRobot />} />
        <Route path="/ai/outbound" element={<Outbound />} />
        <Route path="/ai/aigc" element={<Aigc />} />
        <Route path="/ai/agent-studio" element={<AgentStudio />} />
        <Route path="/ai/mind-studio" element={<MindStudio />} />
        <Route path="/management/quality" element={<Quality />} />
        <Route path="/management/reports" element={<Reports />} />
        <Route path="/management/voc" element={<Voc />} />
        <Route path="/employees" element={<DigitalEmployees />} />
        <Route path="/private-domain" element={<PrivateDomain />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
