import '../../lib/appearance.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyPopupTheme, loadPopupTheme } from './theme';

async function mount() {
  applyPopupTheme(await loadPopupTheme());
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void mount();
