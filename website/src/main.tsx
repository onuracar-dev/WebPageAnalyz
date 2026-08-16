import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import './fonts.css';
import './site.css';
import './portal.css';
import './portal-typography.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
