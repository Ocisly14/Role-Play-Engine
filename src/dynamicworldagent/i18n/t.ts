import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

type Locale = Record<string, string>;

function loadLocale(lang: string): Locale {
  try {
    const filePath = join(__dirname, "locales", lang, "tick.json");
    return JSON.parse(readFileSync(filePath, "utf-8")) as Locale;
  } catch {
    return {};
  }
}

const locales: Record<string, Locale> = {
  en: loadLocale("en"),
  zh: loadLocale("zh"),
};

function resolveLang(lang: string): "en" | "zh" {
  return lang.startsWith("zh") ? "zh" : "en";
}

export function t(
  key: string,
  lang: string,
  params?: Record<string, string | number>
): string {
  const resolved = resolveLang(lang);
  const template = locales[resolved]?.[key] ?? locales.en?.[key] ?? key;
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
    String(params[name] ?? `{{${name}}}`)
  );
}
