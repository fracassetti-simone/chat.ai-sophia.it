import { useEffect } from 'react';
import { connectRealtime } from './lib/api.js';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Login from './pages/Login.jsx';
import Shell from './components/Shell.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Chat from './pages/Chat.jsx';
import Training from './pages/Training.jsx';
import Modules from './pages/Modules.jsx';
import Users from './pages/Users.jsx';
import Tenants from './pages/Tenants.jsx';
import ApiKeys from './pages/ApiKeys.jsx';
import Embed from './pages/Embed.jsx';
import Endpoints from './pages/Endpoints.jsx';
import Settings from './pages/Settings.jsx';
import Flows from './pages/Flows.jsx';
import ExternalChats from './pages/ExternalChats.jsx';
import Contacts from './pages/Contacts.jsx';
import Cloud from './pages/Cloud.jsx';
import Calendar from './pages/Calendar.jsx';
import EmailPage from './pages/Email.jsx';
import CollectFields from './pages/CollectFields.jsx';
import Automations from './pages/Automations.jsx';
import ApiReference from './pages/ApiReference.jsx';
import Compiler from './pages/Compiler.jsx';
import SipCredentials from './pages/SipCredentials.jsx';
import Database from './pages/Database.jsx';

function FullScreenLoader() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
      <div className="skeleton" style={{ width: 120, height: 14 }} />
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (user) connectRealtime();
  }, [user]);
  if (loading) return <FullScreenLoader />;
  if (!user) return (
    <Routes>
      <Route path="*" element={<Login />} />
    </Routes>
  );

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="chat" element={<Chat />} />
        <Route path="chat/:id" element={<Chat />} />
        <Route path="training" element={<Training />} />
        <Route path="modules" element={<Modules />} />
        <Route path="endpoints" element={<Endpoints />} />
        <Route path="users" element={<Users />} />
        <Route path="tenants" element={<Tenants />} />
        <Route path="apikeys" element={<ApiKeys />} />
        <Route path="embed" element={<Embed />} />
        <Route path="settings" element={<Settings />} />
        <Route path="flows" element={<Flows />} />
        <Route path="external-chats" element={<ExternalChats />} />
        <Route path="external-chats/:id" element={<ExternalChats />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="cloud" element={<Cloud />} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="email" element={<EmailPage />} />
        <Route path="compiler" element={<Compiler />} />
        <Route path="collect-fields" element={<CollectFields />} />
        <Route path="automations" element={<Automations />} />
        <Route path="api-reference" element={<ApiReference />} />
        <Route path="sip" element={<SipCredentials />} />
        <Route path="database" element={<Database />} />
        <Route path="database/:schemaId" element={<Database />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
