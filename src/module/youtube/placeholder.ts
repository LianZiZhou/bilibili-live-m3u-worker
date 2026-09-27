import fs = require('fs');
import path = require('path');
import config from '../../config';
import { buildMediaPlaylist } from '../../utils/hls';
import { ffmpegAvailable, imageToTS } from '../../utils/ffmpeg';

export const PLACEHOLDER_DURATION = 4;

const BUILTIN_SEGMENT = path.join(__dirname, '../../../assets/offline.mpegts');

let segment: Promise<Buffer> | null = null;

async function loadSegment(): Promise<Buffer> {
  const image = config.youtube.placeholderImage;
  if(image) {
    if(!fs.existsSync(image)) {
      console.error(`Placeholder image ${image} not found, use builtin placeholder`);
    }
    else if(!(await ffmpegAvailable())) {
      console.error('ffmpeg is not available, can not encode placeholder image, use builtin placeholder');
    }
    else {
      try {
        return await imageToTS(image, PLACEHOLDER_DURATION);
      }
      catch(e) {
        console.error('Failed to encode placeholder image, use builtin placeholder:', e);
      }
    }
  }
  return await fs.promises.readFile(BUILTIN_SEGMENT);
}

export function getPlaceholderSegment(): Promise<Buffer> {
  if(!segment) {
    segment = loadSegment().catch((e) => {
      segment = null;
      throw e;
    });
  }
  return segment;
}

/**
 * A never-ending "live" playlist that repeats the placeholder segment.
 * Sequence numbers follow wall clock time, so players keep polling and
 * pick up the real stream as soon as the channel goes live.
 */
export function buildPlaceholderPlaylist(base: string, now = Date.now()): string {
  const current = Math.floor(now / (PLACEHOLDER_DURATION * 1000));
  const first = current - 2;
  const segments = [first, first + 1, first + 2].map((n) => ({
    uri: `${base}/play/live/yt/offline/${n}.ts`,
    duration: PLACEHOLDER_DURATION,
    // every segment restarts its timestamps
    discontinuity: true,
  }));
  return buildMediaPlaylist({
    targetDuration: PLACEHOLDER_DURATION,
    mediaSequence: first,
    discontinuitySequence: first,
    segments,
  });
}
