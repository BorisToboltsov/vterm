// Pure registry of the Utilities panel (Phase 33). Each entry is a self-contained
// tool rendered in the panel's right pane; this ordered list drives the left-hand
// nav and the search filter. Kept DOM-free (architecture invariant) so it is unit
// tested and so the panel component just maps over it — no tool metadata lives in
// the .svelte file.
import type { IconName } from "./icons";
import type { MessageKey } from "./i18n";
import { matchesQuery } from "./util";

/** A tool shown in the Utilities panel. */
export interface UtilityDef {
  /** Stable id — the selected-tool key and `data-testid` suffix. */
  id: string;
  /** Icon registry name shown in the nav (see icons.ts). */
  icon: IconName;
  /** i18n key for the display name. */
  titleKey: MessageKey;
  /** i18n key for the one-line description (nav subtitle + pane header). */
  descKey: MessageKey;
  /** Bilingual (EN+RU) search keywords — never displayed, only matched. */
  keywords: string;
}

// Registry order = nav order. keygen ("keys") stays first as the original utility.
export const UTILITIES: readonly UtilityDef[] = [
  {
    id: "keys",
    icon: "key",
    titleKey: "util.keys.title",
    descKey: "util.keys.desc",
    keywords: "ssh key keygen generate keypair ed25519 rsa ecdsa passphrase public private fingerprint ключ ключи генерация пара приватный публичный отпечаток",
  },
  {
    id: "knownHosts",
    icon: "shield",
    titleKey: "util.knownHosts.title",
    descKey: "util.knownHosts.desc",
    keywords: "known hosts host key fingerprint trust remove forget ssh известные хосты ключ хоста доверие удалить отпечаток",
  },
  {
    id: "codec",
    icon: "code",
    titleKey: "util.codec.title",
    descKey: "util.codec.desc",
    keywords: "base64 url hex encode decode percent escape unescape кодирование декодирование шестнадцатеричный урл base 64",
  },
  {
    id: "cidr",
    icon: "network",
    titleKey: "util.cidr.title",
    descKey: "util.cidr.desc",
    keywords: "cidr subnet mask netmask network broadcast ip range hosts ipv4 wildcard подсеть маска сеть широковещательный диапазон хосты ip адрес",
  },
  {
    id: "timestamp",
    icon: "clock",
    titleKey: "util.timestamp.title",
    descKey: "util.timestamp.desc",
    keywords: "unix timestamp epoch time date timezone utc iso seconds milliseconds время дата метка эпоха часовой пояс секунды миллисекунды",
  },
  {
    id: "cron",
    icon: "history",
    titleKey: "util.cron.title",
    descKey: "util.cron.desc",
    keywords: "cron crontab schedule expression next run minute hour day month weekday расписание выражение запуск минута час день месяц",
  },
  {
    id: "password",
    icon: "lock",
    titleKey: "util.password.title",
    descKey: "util.password.desc",
    keywords: "password secret generate random passphrase diceware entropy strength length symbols digits пароль секрет генерация случайный фраза энтропия длина символы цифры",
  },
  {
    id: "jwt",
    icon: "braces",
    titleKey: "util.jwt.title",
    descKey: "util.jwt.desc",
    keywords: "jwt json web token decode header payload claims exp iat base64url токен декодировать заголовок полезная нагрузка",
  },
  // ── Network tools (Phase 34) — run on the active session's host (SSH remote /
  // local PTY). Grouped after the offline tools; each needs a live session.
  {
    id: "tls",
    icon: "lock",
    titleKey: "util.tls.title",
    descKey: "util.tls.desc",
    keywords: "tls ssl certificate cert expiry expiration san issuer openssl https handshake сертификат срок годности истечение проверка ssl",
  },
  {
    id: "http",
    icon: "send",
    titleKey: "util.http.title",
    descKey: "util.http.desc",
    keywords: "http https rest api request curl get post put delete headers body webhook postman запрос заголовки тело вебхук",
  },
] as const;

/** The utility selected when the panel first opens. */
export const DEFAULT_UTILITY = UTILITIES[0].id;

/** Whether `id` is a known utility. */
export function isUtility(id: string): boolean {
  return UTILITIES.some((u) => u.id === id);
}

/** Utilities whose keywords match the search query (all when the query is blank). */
export function utilitiesMatching(search: string): UtilityDef[] {
  if (!search.trim()) return [...UTILITIES];
  return UTILITIES.filter((u) => matchesQuery(`${u.keywords} ${u.id}`, search));
}
