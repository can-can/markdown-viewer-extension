import fs from 'node:fs/promises';
import path from 'node:path';

/** One folder as it was left at the last shutdown. */
export interface SessionFolder {
  /** Absolute path on disk. Folder ids are per-run, so the path is the key. */
  path: string;
  tabs: string[];
  activeRelPath: string | null;
  expandedPaths: string[];
}

export interface SessionState {
  version: 1;
  folders: SessionFolder[];
  activeFolderPath: string | null;
}

const SESSION_VERSION = 1;
const SESSION_FILE = 'session.json';

export function sessionFilePath(userDataDir: string): string {
  return path.join(userDataDir, SESSION_FILE);
}

function stringsOnly(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Accept only what we can use, and repair the rest.
 *
 * A damaged session file must never stop the app from starting, so every
 * problem degrades to a smaller session instead of an error.
 */
function parseSession(raw: unknown): SessionState | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (data.version !== SESSION_VERSION) return null;
  if (!Array.isArray(data.folders)) return null;

  const folders: SessionFolder[] = [];
  for (const entry of data.folders) {
    if (!entry || typeof entry !== 'object') continue;
    const folder = entry as Record<string, unknown>;
    if (typeof folder.path !== 'string' || folder.path === '') continue;

    const tabs = stringsOnly(folder.tabs);
    const activeRelPath = typeof folder.activeRelPath === 'string' ? folder.activeRelPath : null;

    folders.push({
      path: folder.path,
      tabs,
      // An active tab that is not in the tab list would leave the UI with a
      // selection it cannot show.
      activeRelPath: activeRelPath && tabs.includes(activeRelPath) ? activeRelPath : null,
      expandedPaths: stringsOnly(folder.expandedPaths),
    });
  }

  const activeFolderPath = typeof data.activeFolderPath === 'string' ? data.activeFolderPath : null;

  return {
    version: SESSION_VERSION,
    folders,
    activeFolderPath: folders.some((f) => f.path === activeFolderPath) ? activeFolderPath : null,
  };
}

export async function readSession(file: string): Promise<SessionState | null> {
  try {
    return parseSession(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    // Missing file, bad permissions, or invalid JSON all mean "no session".
    return null;
  }
}

export async function writeSession(file: string, state: SessionState): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write to a temp file first, then rename. A crash during the write then
  // leaves the previous session intact instead of a truncated file.
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}
