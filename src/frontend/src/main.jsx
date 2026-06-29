import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { TenantProvider } from './context/TenantContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import { ModalProvider } from './context/ModalContext.jsx';
import './styles/tokens.css';
import './styles/app.css';
import 'highlight.js/styles/github.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <ModalProvider>
          <AuthProvider>
            <TenantProvider>
              <App />
            </TenantProvider>
          </AuthProvider>
        </ModalProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
