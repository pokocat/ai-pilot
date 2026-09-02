import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/admin.css';
// shadcn 主题层放在 admin.css **之后**：它只引 theme + utilities（无 preflight），
// 作用域限定在「增长」组新模块（`.sc` 根 + @source 白名单）。见 styles/shadcn.css 头注释。
import './styles/shadcn.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
