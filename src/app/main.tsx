import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installDevtools } from './devtools';
import './global.css';

if (import.meta.env.DEV || new URLSearchParams(location.search).has('devtools')) installDevtools();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
