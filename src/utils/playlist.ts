export function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// m3u attribute values can't contain double quotes, and names can't contain line breaks
function m3uAttr(value: unknown): string {
  return String(value ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}

function m3uName(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ');
}

export interface M3UEntry {
  id: string;
  name: string;
  logo?: string;
  group?: string;
  url: string;
}

export function renderM3U(entries: M3UEntry[], header: Record<string, string> = {}): string {
  const headerAttrs = Object.entries(header).map(([k, v]) => ` ${k}="${m3uAttr(v)}"`).join('');
  const lines = [`#EXTM3U${headerAttrs}`];
  for(const entry of entries) {
    const attrs = [
      `tvg-id="${m3uAttr(entry.id)}"`,
      `tvg-name="${m3uAttr(entry.name)}"`,
      entry.logo ? `tvg-logo="${m3uAttr(entry.logo)}"` : '',
      entry.group ? `group-title="${m3uAttr(entry.group)}"` : '',
    ].filter(Boolean).join(' ');
    lines.push(`#EXTINF:-1 ${attrs},${m3uName(entry.name)}`);
    lines.push(entry.url);
  }
  return lines.join('\n') + '\n';
}

export interface XMLTVChannel {
  id: string;
  name: string;
  icon?: string;
  url?: string;
}

export interface XMLTVProgramme {
  channel: string;
  start: Date;
  stop: Date;
  title: string;
  desc?: string;
  icon?: string;
  url?: string;
}

export function xmltvTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())} +0000`;
}

export function renderXMLTV(channels: XMLTVChannel[], programmes: XMLTVProgramme[], lang = 'zh'): string {
  const channelXml = channels.map((ch) => [
    `<channel id="${xmlEscape(ch.id)}">`,
    `  <display-name>${xmlEscape(ch.name)}</display-name>`,
    ch.icon ? `  <icon src="${xmlEscape(ch.icon)}"/>` : '',
    ch.url ? `  <url>${xmlEscape(ch.url)}</url>` : '',
    '</channel>',
  ].filter(Boolean).join('\n'));
  const programmeXml = programmes.map((p) => [
    `<programme channel="${xmlEscape(p.channel)}" start="${xmltvTime(p.start)}" stop="${xmltvTime(p.stop)}">`,
    `  <title lang="${lang}">${xmlEscape(p.title)}</title>`,
    p.desc ? `  <desc lang="${lang}">${xmlEscape(p.desc)}</desc>` : '',
    p.icon ? `  <icon src="${xmlEscape(p.icon)}"/>` : '',
    p.url ? `  <url>${xmlEscape(p.url)}</url>` : '',
    '</programme>',
  ].filter(Boolean).join('\n'));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${[...channelXml, ...programmeXml].join('\n')}\n</tv>\n`;
}
