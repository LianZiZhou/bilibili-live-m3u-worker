import ytdl = require('@distube/ytdl-core');
import {Hono} from "hono";
import redis from "../../module/redis";
import * as fs from "node:fs";
import ffmpeg = require('fluent-ffmpeg');

import dotenv = require('dotenv');

dotenv.config();

const app = new Hono();

const agent = ytdl.createAgent(JSON.parse(fs.readFileSync("./cookies.json").toString()));

async function fetchYTLiveInfo(video: string) {
    const redisCache = await redis.get(`yt:${video}:info`);
    if(redisCache) {
        return JSON.parse(redisCache);
    }
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${video}`, { agent });
    await redis.set(`yt:${video}:info`, JSON.stringify(info));
    await redis.expire(`yt:${video}:info`, 7200);
    return info;
}

async function processVideoSeq(video: string, seqUrl: string) {
    const seqId = seqUrl.split('/sq/')[1].split('/')[0];
    const redisCache = await redis.get(`yt:${video}:seq:${seqId}`);
    if(!redisCache) {
        await redis.set(`yt:${video}:seq:${seqId}`, seqUrl);
        await redis.expire(`yt:${video}:seq:${seqId}`, 7200);
    }
    return process.env.SERVICE_URL + '/play/live/yt/' + video + '/sq/' + seqId + '.ts';
}

async function processAudioM4SUrl(video: string, audioM4SUrl: string) {
    const redisCache = await redis.get(`yt:${video}:audio`);
    if(!redisCache) {
        await redis.set(`yt:${video}:audio`, audioM4SUrl);
        await redis.expire(`yt:${video}:audio`, 7200);
    }
    return '';
}

app.get('/play/live/yt/:video/index.m3u8', async (c) => {
    const video = c.req.param('video');
    try {
        const ytLiveInfo = await fetchYTLiveInfo(video);
        const audioM4SUrl = ytdl.chooseFormat(ytLiveInfo.formats, {quality: 'highest', filter: 'audioonly'}).url;
        await processAudioM4SUrl(video, audioM4SUrl).catch(console.error);
        const videoHLSUrl = ytdl.chooseFormat(ytLiveInfo.formats, {quality: 'highest'}).url;
        const videoHLSM3U8 = await fetch(videoHLSUrl).then((res) => res.text());
        const videoHLSSplit = videoHLSM3U8.split('\n');
        const videoSeqs = [];
        for (const line of videoHLSSplit) {
            if(!line.startsWith('#') && line.length > 0) {
                videoSeqs.push(line);
                await processVideoSeq(video, line).catch(console.error);
            }
        }
        const videoHLSM3U8WithAudio = videoHLSSplit.map((line) => {
            if(!line.startsWith('#') && line.length > 0) {
                return process.env.SERVICE_URL + '/play/live/yt/' + video + '/sq/' + line.split('/sq/')[1].split('/')[0] + '.ts';
            }
            return line;
        }).join('\n');
        return c.text(videoHLSM3U8WithAudio);
    }
    catch(e) {
        console.error(e);
        c.status(500);
        return c.text('Failed to fetch YouTube live room play url');
    }
});

app.get('/play/live/yt/:video/sq/:seq', async (c) => {
    const video = c.req.param('video');
    const seq = c.req.param('seq').split('.')[0];
    let startTime = Date.now();
    const seqUrl = await redis.get(`yt:${video}:seq:${seq}`);
    if(!seqUrl) {
        c.status(404);
        return c.text('Seq not found');
    }
    const audioUrl = await redis.get(`yt:${video}:audio`);
    if(!audioUrl) {
        c.status(404);
        return c.text('Audio not found');
    }
    const seqRes = await fetch(seqUrl);
    const audioRes = await fetch(audioUrl + '&sq=' + seq);
    if(seqRes.status !== 200) {
        c.status(500);
        return c.text('Failed to fetch seq');
    }
    if(audioRes.status !== 200) {
        c.status(500);
        return c.text('Failed to fetch audio');
    }
    fs.writeFileSync(`./tmp/${video}-${seq}.ts`, await seqRes.arrayBuffer().then((buffer) => Buffer.from(buffer)));
    fs.writeFileSync(`./tmp/${video}-${seq}-audio.m4a`, await audioRes.arrayBuffer().then((buffer) => Buffer.from(buffer)));
    console.log('YT Origin TS Downloaded, used', Date.now() - startTime, 'ms');
    startTime = Date.now();
    await new Promise<void>((resolve, reject) => {
        const ffmC = ffmpeg(`./tmp/${video}-${seq}.ts`)
            .input(`./tmp/${video}-${seq}-audio.m4a`)
            .outputOptions([
                '-c:v copy',
                '-c:a copy',
                '-f mpegts',
                '-copyts',
            ])
            .on('start', (cmd: string) => {
                console.log('Start FFmpeg:', cmd);
            })
            .on('end', () => {
                resolve();
                fs.unlinkSync(`./tmp/${video}-${seq}.ts`);
                fs.unlinkSync(`./tmp/${video}-${seq}-audio.m4a`);
            })
            .on('error', (err: any) => {
                console.error('FFmpeg Error:', err);
                reject(err);
            })
            .output(`./tmp/${video}-${seq}-final.ts`);
        ffmC.run();
    });
    console.log('YT TS Muxed, used', Date.now() - startTime, 'ms');
    c.header('content-type', 'application/octet-stream');
    const fileBuffer = fs.readFileSync(`./tmp/${video}-${seq}-final.ts`);
    fs.unlinkSync(`./tmp/${video}-${seq}-final.ts`);
    const arrayBuffer = fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength) as ArrayBuffer;
    return c.body(arrayBuffer);
});

export default app;