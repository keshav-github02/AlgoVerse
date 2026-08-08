/**
 * Where a saved simulation goes: the URL, or local storage.
 *
 * The browser APIs live here rather than in `engine.ts`, which stays free of
 * DOM references so its behaviour can be checked under Node.
 */

import { decodeSimulation, encodeSimulation, type SimulationFile } from '@algoverse/core';

const AUTOSAVE_KEY = 'algoverse:autosave';
const URL_KEY = 's';

export function shareLink(file: SimulationFile): string {
  const url = new URL(window.location.href);
  url.hash = '';
  url.searchParams.set(URL_KEY, encodeSimulation(file));
  return url.toString();
}

export function readFromUrl(): SimulationFile | null {
  const encoded = new URL(window.location.href).searchParams.get(URL_KEY);
  if (encoded === null) return null;
  const decoded = decodeSimulation(encoded);
  return decoded.ok ? decoded.file : null;
}

/** The error, when a link is present but unreadable - worth telling the user. */
export function urlError(): string | null {
  const encoded = new URL(window.location.href).searchParams.get(URL_KEY);
  if (encoded === null) return null;
  const decoded = decodeSimulation(encoded);
  return decoded.ok ? null : `${decoded.error.message} (${decoded.error.hint ?? ''})`;
}

export function clearUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete(URL_KEY);
  window.history.replaceState(null, '', url.toString());
}

export function autosave(file: SimulationFile): void {
  try {
    window.localStorage.setItem(AUTOSAVE_KEY, encodeSimulation(file));
  } catch {
    // Private browsing, or a full quota. Losing an autosave is not worth an alert.
  }
}

export function readAutosave(): SimulationFile | null {
  try {
    const stored = window.localStorage.getItem(AUTOSAVE_KEY);
    if (stored === null) return null;
    const decoded = decodeSimulation(stored);
    return decoded.ok ? decoded.file : null;
  } catch {
    return null;
  }
}

export function clearAutosave(): void {
  try {
    window.localStorage.removeItem(AUTOSAVE_KEY);
  } catch {
    // Nothing useful to do.
  }
}

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
