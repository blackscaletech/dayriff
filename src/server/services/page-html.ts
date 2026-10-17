/** Shared escaping and metadata replacement for public HTML shells. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]!));
}
export function htmlAttributes(tag: string): Map<string, string> {
  return new Map([...tag.matchAll(/(?:^|\s)([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)].map(match => [match[1]!.toLowerCase(), (match[2] ?? match[3] ?? match[4] ?? '').toLowerCase()]));
}
/** Keep application scripts/assets, but never let stale page identity leak to another page. */
export function replacePageMetadata(template: string, tags: string): string {
  const html = template.replace(/<title\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/title\s*>/gi, '')
    .replace(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => {
      const attrs = htmlAttributes(tag), name = attrs.get('name') ?? attrs.get('property') ?? '';
      return ['description', 'robots', 'referrer', 'theme-color', 'author', 'application-name'].includes(name) || /^(?:og:|twitter:)/.test(name) ? '' : tag;
    }).replace(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, tag => htmlAttributes(tag).get('rel') === 'canonical' ? '' : tag)
    .replace(/<script\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/script\s*>/gi, tag => htmlAttributes(tag).get('type') === 'application/ld+json' ? '' : tag);
  return html.replace(/<\/head\s*>/i, `${tags}</head>`);
}
