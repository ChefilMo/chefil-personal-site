import { ui, defaultLang, languages, type Lang } from './ui';

export function useTranslations(lang: Lang) {
  return function t(key: keyof (typeof ui)[typeof defaultLang]): string {
    return ui[lang][key] ?? ui[defaultLang][key];
  };
}

/** 取另一语言代码 */
export function otherLang(lang: Lang): Lang {
  return lang === 'zh' ? 'en' : 'zh';
}

/** 把当前路径改写为目标语言路径（含 base 前缀）：/base/zh/about -> /base/en/about */
export function getLocalizedPath(pathname: string, lang: Lang): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, ''); // '' 或 '/chefil-personal-site'
  const localePrefix = new RegExp(`^${base}/(zh|en)(?=\\/|$)`);
  if (localePrefix.test(pathname)) {
    return pathname.replace(localePrefix, `${base}/${lang}`);
  }
  // 无语言前缀的路径（如 404），回退到目标语言首页
  return `${base}/${lang}/`;
}

export { languages, defaultLang };
export type { Lang };
