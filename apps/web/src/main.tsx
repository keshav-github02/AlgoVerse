import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SCENE_STYLES } from '@algoverse/renderer';
import { App } from './App.tsx';
import './styles.css';

/*
 * The scene's styles come from the renderer itself rather than from a copy in
 * this app's stylesheet. They were copied once, with a comment claiming they
 * were verbatim, and they had quietly drifted: the app was missing the link
 * edge treatment, every transition, and the rule that hides a node's tick
 * unless it is highlighted - so ticks showed permanently here and nowhere
 * else. Importing the string means the app and the generated demo page cannot
 * disagree again.
 *
 * Appended after the stylesheet so the variables it defines are already there.
 */
const sheet = document.createElement('style');
sheet.textContent = SCENE_STYLES;
document.head.append(sheet);

const host = document.getElementById('root');
if (host === null) throw new Error('missing #root');
createRoot(host).render(<StrictMode><App /></StrictMode>);
