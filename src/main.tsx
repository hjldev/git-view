import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getPref } from './store';
import { applyTheme, type Theme } from './views/Workspace';
import './styles.css';

applyTheme(getPref<Theme>('theme', 'dark'));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(getPref<Theme>('theme', 'dark')));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
