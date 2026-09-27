export interface HLSVariant {
  uri: string;
  bandwidth: number;
  width: number;
  height: number;
  fps: number;
  codecs: string;
}

export interface HLSSegment {
  uri: string;
  duration: number;
  seq: number;
}

export interface HLSMediaPlaylist {
  targetDuration: number;
  mediaSequence: number;
  segments: HLSSegment[];
  ended: boolean;
}

function parseAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = line.slice(line.indexOf(':') + 1);
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while((m = re.exec(body))) {
    attrs[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

export function parseMasterPlaylist(text: string): HLSVariant[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants: HLSVariant[] = [];
  for(let i = 0; i < lines.length; i++) {
    if(!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = parseAttributes(lines[i]);
    let j = i + 1;
    while(j < lines.length && (lines[j].length === 0 || lines[j].startsWith('#'))) j++;
    if(j >= lines.length) break;
    const [width, height] = (attrs['RESOLUTION'] || '0x0').split('x').map((n) => parseInt(n, 10) || 0);
    variants.push({
      uri: lines[j],
      bandwidth: parseInt(attrs['BANDWIDTH'] || '0', 10) || 0,
      width,
      height,
      fps: parseFloat(attrs['FRAME-RATE'] || '0') || 0,
      codecs: attrs['CODECS'] || '',
    });
    i = j;
  }
  return variants;
}

// pick highest variant whose height <= maxHeight (0 = unlimited), or the lowest one if none fits
export function selectVariant<T extends { height: number; bandwidth: number }>(variants: T[], maxHeight: number): T | undefined {
  if(variants.length === 0) return undefined;
  const sorted = [...variants].sort((a, b) => (a.height - b.height) || (a.bandwidth - b.bandwidth));
  const fit = maxHeight > 0 ? sorted.filter((v) => v.height <= maxHeight) : sorted;
  return fit.length > 0 ? fit[fit.length - 1] : sorted[0];
}

// YouTube segment urls carry their sequence number as /sq/<n>/
export function extractYTSeq(uri: string): number | null {
  const m = uri.match(/\/sq\/(\d+)(?:\/|$)/) || uri.match(/[?&]sq=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export function parseMediaPlaylist(text: string): HLSMediaPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let targetDuration = 0, mediaSequence = 0, ended = false;
  const segments: HLSSegment[] = [];
  let pendingDuration = 0;
  for(const line of lines) {
    if(line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(line.split(':')[1]) || 0;
    }
    else if(line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
    }
    else if(line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
    }
    else if(line === '#EXT-X-ENDLIST') {
      ended = true;
    }
    else if(line.length > 0 && !line.startsWith('#')) {
      const seq = extractYTSeq(line) ?? (mediaSequence + segments.length);
      segments.push({ uri: line, duration: pendingDuration, seq });
      pendingDuration = 0;
    }
  }
  return { targetDuration, mediaSequence, segments, ended };
}

/**
 * Rewrite a media playlist: every segment uri is replaced by mapUri(segment),
 * and the media sequence is shifted by seqOffset (keeps sequence numbers
 * monotonic when switching from the offline placeholder to a live stream).
 */
export function rewriteMediaPlaylist(text: string, mapUri: (segment: HLSSegment) => string, seqOffset = 0): string {
  const playlist = parseMediaPlaylist(text);
  let segIndex = 0;
  return text.split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if(line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      return `#EXT-X-MEDIA-SEQUENCE:${playlist.mediaSequence + seqOffset}`;
    }
    if(line.length > 0 && !line.startsWith('#')) {
      const segment = playlist.segments[segIndex++];
      return mapUri(segment);
    }
    return raw;
  }).join('\n');
}

export interface SyntheticSegment {
  uri: string;
  duration: number;
  discontinuity?: boolean;
}

export function buildMediaPlaylist(opts: {
  targetDuration: number;
  mediaSequence: number;
  discontinuitySequence?: number;
  segments: SyntheticSegment[];
}): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(opts.targetDuration)}`,
    `#EXT-X-MEDIA-SEQUENCE:${opts.mediaSequence}`,
  ];
  if(opts.discontinuitySequence !== undefined) {
    lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${opts.discontinuitySequence}`);
  }
  for(const segment of opts.segments) {
    if(segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${segment.duration.toFixed(3)},`);
    lines.push(segment.uri);
  }
  return lines.join('\n') + '\n';
}
