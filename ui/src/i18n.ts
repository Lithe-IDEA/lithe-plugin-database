// Interface text. Messages are keyed by their English text; zh-Hans.ts holds
// the Simplified Chinese translations, and i18n.test.ts checks that every
// message the source uses has one. `{name}` placeholders are filled from
// the values passed.
import { lithe } from './bridge.ts';
import { zhHans } from './zh-Hans.ts';

const chinese = /^zh(?:[-_](?:hans|cn|sg))?\b/i.test(lithe.context.locale) || lithe.context.locale.toLowerCase().startsWith('zh');

export function t(message: string, values?: Record<string, string | number>): string {
  const text = (chinese && zhHans[message]) || message;
  return values ? text.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match)) : text;
}

export const isChinese = chinese;
