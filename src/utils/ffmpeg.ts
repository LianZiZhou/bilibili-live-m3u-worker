import { spawn } from 'child_process';
import fs = require('fs');
import os = require('os');
import path = require('path');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

let available: Promise<boolean> | null = null;

export function ffmpegAvailable(): Promise<boolean> {
  if(!available) {
    available = new Promise((resolve) => {
      const proc = spawn(FFMPEG, ['-version'], { stdio: 'ignore' });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }
  return available;
}

export function runFFmpeg(args: string[], timeoutMs = 30000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (d) => stdout.push(d));
    proc.stderr.on('data', (d) => stderr.push(d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if(code === 0) {
        resolve(Buffer.concat(stdout));
      }
      else {
        reject(new Error(`ffmpeg exited with ${code}: ${Buffer.concat(stderr).toString().trim()}`));
      }
    });
  });
}

/**
 * Mux a video-only and an audio-only segment (e.g. YouTube DASH fMP4 chunks)
 * into a single MPEG-TS segment without re-encoding, keeping original timestamps.
 */
export async function muxToTS(video: Buffer, audio: Buffer): Promise<Buffer> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ytmux-'));
  try {
    const videoPath = path.join(dir, 'video');
    const audioPath = path.join(dir, 'audio');
    await Promise.all([
      fs.promises.writeFile(videoPath, video),
      fs.promises.writeFile(audioPath, audio),
    ]);
    return await runFFmpeg([
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c', 'copy',
      '-copyts',
      '-muxdelay', '0',
      '-f', 'mpegts',
      'pipe:1',
    ]);
  }
  finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

// Encode a still image (plus silent audio) into a MPEG-TS segment
export async function imageToTS(imagePath: string, seconds: number): Promise<Buffer> {
  return await runFFmpeg([
    '-loop', '1',
    '-framerate', '25',
    '-i', imagePath,
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-t', String(seconds),
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
    '-c:v', 'libx264',
    '-tune', 'stillimage',
    '-profile:v', 'main',
    '-g', '100',
    '-r', '25',
    '-c:a', 'aac',
    '-b:a', '32k',
    '-shortest',
    '-f', 'mpegts',
    'pipe:1',
  ], 60000);
}
