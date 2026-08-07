import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

const host = document.getElementById('root');
if (host === null) throw new Error('missing #root');
createRoot(host).render(<StrictMode><App /></StrictMode>);
