import { Hono } from 'hono';
import redis from "./module/redis";
import { logger } from './middleware/logger';
import { getConnInfo } from 'hono/bun';

import bililive from "./routes/bililive";

const app = new Hono();

app.use(logger());

app.route('', bililive);

const _subInfo = [
  {
    cid: 21756924,
    name: '雪绘Yukie',
    title: '雪绘Yukie直播间',
  },{
  cid: 6,
  name: '哔哩哔哩英雄联盟赛事',
  title: '哔哩哔哩英雄联盟赛事直播间',
}];

async function fetchBiliLiveRoomList() {
  const cachedList = await redis.get('bili:live:room:list');
  if(cachedList) {
    return JSON.parse(cachedList);
  }
  const list = [];
  for(let i = 1; i <= 10; i++) {
    const res = await fetch(`https://api.live.bilibili.com/xlive/web-interface/v1/second/getList?platform=web&parent_area_id=9&area_id=0&sort_type=sort_type_291&page=${i}`);
    const { code, data } = await res.json();
    if(code !== 0) {
      throw new Error(`Failed to fetch BiliBili live room list, code: ${code}`);
    }
    for (const room of data.list) {
      await redis.set(`bili:user_avatar:${room.roomid}`, room.face);
    }
    list.push(...data.list);
  }
  await redis.set('bili:live:room:list', JSON.stringify(list));
  await redis.expire('bili:live:room:list', 3600);
  return list;
}

app.get('/subscribe/bili/live.m3u', async (c) => {
  let subInfo = _subInfo;
  try {
    subInfo = (await fetchBiliLiveRoomList()).map((room: { roomid: any; uname: any; }) => {
      return {
        cid: room.roomid,
        name: room.uname
      }
    });
  }
  catch(e) {
    console.error(e);
  }
  return c.text(`#EXTM3U url-logos="${process.env.SERVICE_URL}/meta/live/bili/cover/"\n
${
  subInfo.map((info) => {
    return `#EXTINF:-1 tvg-id="${info.cid}" tvg-name="${info.name}" tvg-logo="${info.cid}",${info.name}\n${process.env.SERVICE_URL}/play/live/bili/${info.cid}/index.m3u8`;
  }).join('\n')
  }
`);
});

app.get('/subscribe/bili/guide.xml', async (c) => {
  let subInfo = _subInfo;
  try {
    subInfo = (await fetchBiliLiveRoomList()).map((room: {
      title: any;
      roomid: any; uname: any; }) => {
      return {
        cid: room.roomid,
        name: room.uname,
        title: room.title
      }
    });
  }
  catch(e) {
    console.error(e);
  }
  return c.text(`<?xml version="1.0" encoding="UTF-8"?>
<tv>
${
  subInfo.map((info) => {
    return `<channel id="${info.cid}">
  <display-name>${info.name}</display-name>
  <icon src="${process.env.SERVICE_URL}/meta/live/bili/user_avatar/${info.cid}.jpg"/>
  <url>https://live.bilibili.com/${info.cid}</url>
</channel>`;
  }
  ).join('\n')
}
${
    subInfo.map((info) => {
        return `<programme channel="${info.cid}" start="20240101000000 +0000" stop="20770101000000 +0000">
  <title lang="zh">${info.title}</title>
  <icon src="${process.env.SERVICE_URL}/meta/live/bili/cover/${info.cid}.jpg"/>
  <url>https://live.bilibili.com/${info.cid}</url>
</programme>`;
      }
    ).join('\n')
  }
</tv>
`);
});

app.get('/meta/live/bili/cover/:cid', async (c) => {
  const cid = c.req.param('cid').split('.')[0];
  const cachedCover = await redis.get(`bili:${cid}:cover`);
  if(cachedCover) {
    const buffer = Buffer.from(cachedCover.split(';base64,')[1], 'base64');
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    c.header('content-type', cachedCover.split(';base64,')[0].split(':')[1] || 'application/octet-stream');
    return c.body(arrayBuffer);
  }
  const response = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${cid}`);
  if(response.status !== 200) {
    c.status(404);
    return c.text('Not Found');
  }
  const { code, data } = await response.json();
  if(code !== 0 || !data) {
    c.status(404);
    return c.text('Not Found');
  }
  const { user_cover } = data;
  const coverResponse = await fetch(user_cover);
  if(coverResponse.status !== 200) {
    c.status(404);
    return c.text('Not Found');
  }
  c.header('content-type', coverResponse.headers.get('content-type') || 'application/octet-stream');
  const buffer = await coverResponse.arrayBuffer();
  const bufferDataUrl = 'data:' + coverResponse.headers.get('content-type') + ';base64,' + Buffer.from(buffer).toString('base64');
  await redis.set(`bili:${cid}:cover`, bufferDataUrl);
  await redis.expire(`bili:${cid}:cover`, 3600);
  return c.body(buffer);
});

app.get('/meta/live/bili/user_avatar/:cacheImageId', async (c) => {
  const cacheImageId = c.req.param('cacheImageId').split('.')[0];
  const imageUrl = await redis.get(`bili:user_avatar:${cacheImageId}`);
  if(!imageUrl) {
    c.status(404);
    return c.text('Not Found');
  }
  const cachedCover = await redis.get(`bili:user_avatar:${cacheImageId}:cache`);
  if(cachedCover) {
    const buffer = Buffer.from(cachedCover.split(';base64,')[1], 'base64');
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    c.header('content-type', cachedCover.split(';base64,')[0].split(':')[1] || 'application/octet-stream');
    return c.body(arrayBuffer);
  }
  const response = await fetch(imageUrl);
  if(response.status !== 200) {
    c.status(404);
    return c.text('Not Found');
  }
  c.header('content-type', response.headers.get('content-type') || 'application/octet-stream');
  const buffer = await response.arrayBuffer();
  const bufferDataUrl = 'data:' + response.headers.get('content-type') + ';base64,' + Buffer.from(buffer).toString('base64');
  await redis.set(`bili:user_avatar:${cacheImageId}:cache`, bufferDataUrl);
  await redis.expire(`bili:user_avatar:${cacheImageId}:cache`, 60 * 60 * 72);
  return c.body(buffer);
});

export default {
  port: process.env.PORT || 10028,
  fetch: app.fetch,
};
