import sanitize from 'sanitize-filename';

export function cleanName(input: string, fallback = 'sem-nome'): string {
  const normalized = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const sanitized = sanitize(normalized) || fallback;
  return sanitized.slice(0, 120).trim() || fallback;
}

export function numberedName(index: number, name: string): string {
  return `${String(index).padStart(2, '0')} - ${cleanName(name)}`;
}

export function slugify(input: string): string {
  return cleanName(input)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
