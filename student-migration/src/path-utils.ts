import { fileURLToPath } from "node:url";

export function normalizeLocalPathInput(value: string): string {
  const unquoted = stripBalancedQuotes(value.trim()).replace(/\\ /g, " ");

  if (unquoted.startsWith("file://")) {
    return fileURLToPath(unquoted);
  }

  if (unquoted === "~") {
    return process.env.HOME ?? unquoted;
  }

  if (unquoted.startsWith("~/")) {
    const home = process.env.HOME;
    return home ? `${home}${unquoted.slice(1)}` : unquoted;
  }

  return unquoted;
}

function stripBalancedQuotes(value: string): string {
  if (value.length < 2) return value;

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
    return value.slice(1, -1);
  }

  return value;
}
