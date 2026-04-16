import fs from 'fs';
import path from 'path';

import { SENDER_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

const DEFAULT_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: true,
};

function isValidEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const validAllow =
    e.allow === '*' ||
    (Array.isArray(e.allow) && e.allow.every((v) => typeof v === 'string'));
  const validMode = e.mode === 'trigger' || e.mode === 'drop';
  return validAllow && validMode;
}

export function loadSenderAllowlist(
  pathOverride?: string,
): SenderAllowlistConfig {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    logger.warn(
      { err, path: filePath },
      'sender-allowlist: cannot read config',
    );
    return DEFAULT_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: filePath }, 'sender-allowlist: invalid JSON');
    return DEFAULT_CONFIG;
  }

  const obj = parsed as Record<string, unknown>;

  if (!isValidEntry(obj.default)) {
    logger.warn(
      { path: filePath },
      'sender-allowlist: invalid or missing default entry',
    );
    return DEFAULT_CONFIG;
  }

  const chats: Record<string, ChatAllowlistEntry> = {};
  if (obj.chats && typeof obj.chats === 'object') {
    for (const [jid, entry] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      if (isValidEntry(entry)) {
        chats[jid] = entry;
      } else {
        logger.warn(
          { jid, path: filePath },
          'sender-allowlist: skipping invalid chat entry',
        );
      }
    }
  }

  return {
    default: obj.default as ChatAllowlistEntry,
    chats,
    logDenied: obj.logDenied !== false,
  };
}

function getEntry(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const entry = getEntry(chatJid, cfg);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return getEntry(chatJid, cfg).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug(
      { chatJid, sender },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}

// --- Cached accessor ---
// loadSenderAllowlist() does a sync readFile + JSON.parse + validate on every
// call. The message loop hits this on every iteration (and again per inbound
// message in drop-mode), so we cache the result and invalidate via fs.watch on
// the parent directory. The plain loadSenderAllowlist() export is kept as a
// pure function for tests that pass an explicit pathOverride.

let cachedConfig: SenderAllowlistConfig | null = null;
let watcherInitialized = false;

function ensureWatcher(): void {
  if (watcherInitialized) return;
  watcherInitialized = true;
  const dir = path.dirname(SENDER_ALLOWLIST_PATH);
  const fileName = path.basename(SENDER_ALLOWLIST_PATH);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const watcher = fs.watch(dir, (_event, name) => {
      // name can be null on some platforms; invalidate conservatively.
      if (!name || name === fileName) cachedConfig = null;
    });
    watcher.on('error', (err) =>
      logger.warn(
        { err, dir },
        'sender-allowlist: watcher error; cache may go stale',
      ),
    );
    watcher.unref();
  } catch (err) {
    logger.warn(
      { err, dir },
      'sender-allowlist: cannot watch directory; cache may be stale',
    );
  }
}

/**
 * Returns the cached allowlist config, loading it on first call and on every
 * invalidation triggered by an fs.watch event on the config file.
 *
 * Use this in hot paths (message loop). Tests should call loadSenderAllowlist()
 * directly with a pathOverride to bypass the cache.
 */
export function getSenderAllowlist(): SenderAllowlistConfig {
  ensureWatcher();
  if (cachedConfig === null) {
    cachedConfig = loadSenderAllowlist();
  }
  return cachedConfig;
}

/** @internal - for tests only. */
export function _resetSenderAllowlistCache(): void {
  cachedConfig = null;
  watcherInitialized = false;
}
