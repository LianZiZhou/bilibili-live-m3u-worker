import { Hono } from 'hono';
import redis from "../../module/redis";
import config from '../../config';
import { fetchCachedImage, sendBinary } from '../../utils/binaryCache';
import { renderM3U, renderXMLTV, type M3UEntry, type XMLTVChannel, type XMLTVProgramme } from '../../utils/playlist';
import { getBaseUrl } from '../../utils/request';

const app = new Hono();

const fetchBiliLiveRoomPlayUrl = async (cid: string) => {
  const cachedPlayUrl = await redis.get(`bili:${cid}:playUrl`);
  if(cachedPlayUrl) {
    return JSON.parse(cachedPlayUrl) as BiliLiveRoomPlayUrlResponse;
  }
  const response = await fetch(`https://api.live.bilibili.com/room/v1/Room/playUrl?cid=${cid}&quality=4&platform=h5`);
  if(response.status !== 200) {
    throw new Error(`Failed to fetch BiliBili live room play url, status: ${response.status}`);
  }
  const data = await response.json() as BiliLiveRoomPlayUrlResponse;
  await redis.set(`bili:${cid}:playUrl`, JSON.stringify(data));
  await redis.expire(`bili:${cid}:playUrl`, 360);
  return data;
}

const responseXAPILikeOriginAPI = async (data: XAPIBiliLiveRoomPlayUrlResponse) => {
  return {
    code: data.code,
    message: data.message,
    data: {
      accept_quality: '4',
      current_quality: 4,
      current_qn: 30000,
      current_qn_name: '原画',
      format: 'm3u8',
      from: 'bilibili',
      quality_description: '原画',
      durl: data.data!.playurl_info.playurl.stream[0].format[0].codec.sort((a,b) =>
        a.current_qn - b.current_qn
      ).map((codec) => {
        return {
          url: codec.url_info[0].host + codec.base_url + codec.url_info[0].extra,
          length: 0,
          order: 0,
          stream_type: 0,
          p2p_type: 0
        }
      })
    }
  } as BiliLiveRoomPlayUrlResponse;
}

const fetchXAPIBiliLiveRoomPlayUrl = async (cid: string) => {
  const cachedPlayUrl = await redis.get(`bili:xapi:${cid}:playUrl`);
  if(cachedPlayUrl) {
    return responseXAPILikeOriginAPI(JSON.parse(cachedPlayUrl) as XAPIBiliLiveRoomPlayUrlResponse);
  }
  const response = await fetch(`https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${cid}&protocol=1&format=2&codec=0,1,2&qn=30000&platform=web&ptype=8&dolby=5&panorama=1&hdr_type=0,1`, {
    method: 'GET',
    headers: {
      'Cookie': 'SESSDATA=' + config.bilibili.sessdata
    }
  });
  if(response.status !== 200) {
    throw new Error(`Failed to fetch BiliBili live room play url, status: ${response.status}`);
  }
  const data = await response.json() as XAPIBiliLiveRoomPlayUrlResponse;
  await redis.set(`bili:xapi:${cid}:playUrl`, JSON.stringify(data));
  await redis.expire(`bili:xapi:${cid}:playUrl`, 360);
  return responseXAPILikeOriginAPI(data);
}

app.get('/play/live/bili/:cid/index.m3u8', async (c) => {
  const cid = c.req.param('cid');
  try {
    const biliLiveRoomPlayUrlRes = await fetchXAPIBiliLiveRoomPlayUrl(cid);
    const { code, data } = biliLiveRoomPlayUrlRes;
    if(code !== 0 || !data) {
      c.status(500);
      return c.text('Stream Unavailable, failed to fetch play url');
    }
    const { durl } = data;
    if(durl.length === 0) {
      c.status(500);
      return c.text('Stream Unavailable, no durl');
    }
    const { url } = durl[durl.length - 1];
    const urlParsed = new URL(url);
    const expires = urlParsed.searchParams.get('expires');
    c.header('content-type', 'application/vnd.apple.mpegurl');
    const response = await fetch(url);
    if(response.status !== 200) {
      c.status(500);
      await redis.del(`bili:${cid}:playUrl`);
      return c.text('Stream Unavailable, failed to fetch stream');
    }
    const text = await response.text();
    const textSplit = text.split('\n');
    const medias = textSplit.filter((line) => !line.startsWith('#') && line.length > 0);
    let AllowCache = false, TargetDuration = 0, XMapURI = '';
    for (const line of textSplit) {
      if(line.startsWith('#EXT-X-ALLOW-CACHE')) {
        if(line.split(':')[1] === 'YES') {
          AllowCache = true;
        }
      }
      if(line.startsWith('#EXT-X-TARGETDURATION')) {
        TargetDuration = parseInt(line.split(':')[1]);
      }
      if(line.startsWith('#EXT-X-MAP:URI')) {
        XMapURI = line.split(':URI=')[1].replace(/"/g, '');
      }
    }
    for (const media of medias) {
      await redis.set(`bili:${cid}:${media}:durl`, url);
      await redis.expire(`bili:${cid}:${media}:durl`, 360);
    }
    if(XMapURI) {
      await redis.set(`bili:${cid}:${XMapURI}:durl`, url);
      await redis.expire(`bili:${cid}:${XMapURI}:durl`, 360);
    }
    // @ts-ignore
    c.set('log', `<-- ${urlParsed.host} Direct`);
    return c.text(text);
  }
  catch(e) {
    console.log(e);
    c.status(500);
    return c.text('Stream Unavailable');
  }
});

app.get('/play/live/bili/:cid/:media', async (c) => {
  const cid = c.req.param('cid');
  const media = c.req.param('media');
  const cachedMedia = media.startsWith('h') ? null : await redis.get(`bili:live:cache:media:${cid}:${media}`);
  if(cachedMedia) {
    const buffer = Buffer.from(cachedMedia.split(';base64,')[1], 'base64');
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    c.header('content-type', cachedMedia.split(';base64,')[0].split(':')[1] || 'application/octet-stream');
    // @ts-ignore
    c.set('log', 'Hit');
    return c.body(arrayBuffer);
  }
  const durl = await redis.get(`bili:${cid}:${media}:durl`);
  if(!durl) {
    c.status(404);
    return c.text('Stream Unavailable');
  }
  const mediaUrl = durl.replace(/\/[^/]+\.m3u8/, `/${media}`);
  const response = await fetch(mediaUrl);
  if(response.status !== 200) {
    c.status(500);
    return c.text('Stream Unavailable');
  }
  const parsedUrl = new URL(mediaUrl);
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const buffer = await response.arrayBuffer();
  const bufferDataUrl = 'data:' + contentType + ';base64,' + Buffer.from(buffer).toString('base64');
  if(!media.startsWith('h')) {
    await redis.set(`bili:live:cache:media:${cid}:${media}`, bufferDataUrl);
    await redis.expire(`bili:live:cache:media:${cid}:${media}`, 60);
    // @ts-ignore
    c.set('log', `<-- ${parsedUrl.host} Missed`);
  }
  else {
    // @ts-ignore
    c.set('log', `<-- ${parsedUrl.host} Direct`);
  }
  c.header('content-type', contentType);
  return c.body(buffer);
});

const defaultSubInfo = [
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

async function getSubInfo(): Promise<{ cid: number; name: string; title: string }[]> {
  try {
    return (await fetchBiliLiveRoomList()).map((room: { roomid: number; uname: string; title: string }) => ({
      cid: room.roomid,
      name: room.uname,
      title: room.title,
    }));
  }
  catch(e) {
    console.error(e);
    return defaultSubInfo;
  }
}

export async function buildBiliM3UEntries(base: string): Promise<M3UEntry[]> {
  return (await getSubInfo()).map((info) => ({
    id: String(info.cid),
    name: info.name,
    logo: `${base}/meta/live/bili/cover/${info.cid}.jpg`,
    group: 'Bilibili',
    url: `${base}/play/live/bili/${info.cid}/index.m3u8`,
  }));
}

export async function buildBiliGuide(base: string): Promise<{ channels: XMLTVChannel[]; programmes: XMLTVProgramme[] }> {
  const subInfo = await getSubInfo();
  return {
    channels: subInfo.map((info) => ({
      id: String(info.cid),
      name: info.name,
      icon: `${base}/meta/live/bili/user_avatar/${info.cid}.jpg`,
      url: `https://live.bilibili.com/${info.cid}`,
    })),
    programmes: subInfo.map((info) => ({
      channel: String(info.cid),
      start: new Date('2024-01-01T00:00:00Z'),
      stop: new Date('2077-01-01T00:00:00Z'),
      title: info.title,
      icon: `${base}/meta/live/bili/cover/${info.cid}.jpg`,
      url: `https://live.bilibili.com/${info.cid}`,
    })),
  };
}

app.get('/subscribe/bili/live.m3u', async (c) => {
  const base = getBaseUrl(c);
  return c.text(renderM3U(await buildBiliM3UEntries(base), { 'url-logos': `${base}/meta/live/bili/cover/` }));
});

app.get('/subscribe/bili/guide.xml', async (c) => {
  const { channels, programmes } = await buildBiliGuide(getBaseUrl(c));
  return c.text(renderXMLTV(channels, programmes));
});

app.get('/meta/live/bili/cover/:cid', async (c) => {
  const cid = c.req.param('cid').split('.')[0];
  const cachedCoverUrl = await redis.get(`bili:${cid}:cover_url`);
  let coverUrl = cachedCoverUrl;
  if(!coverUrl) {
    const response = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${cid}`);
    if(response.status !== 200) {
      c.status(404);
      return c.text('Not Found');
    }
    const { code, data } = await response.json();
    if(code !== 0 || !data?.user_cover) {
      c.status(404);
      return c.text('Not Found');
    }
    coverUrl = data.user_cover as string;
    await redis.set(`bili:${cid}:cover_url`, coverUrl, 'EX', 3600);
  }
  const image = await fetchCachedImage(`bili:${cid}:cover:bin`, coverUrl, 3600);
  if(!image) {
    c.status(404);
    return c.text('Not Found');
  }
  return sendBinary(c, image);
});

app.get('/meta/live/bili/user_avatar/:cacheImageId', async (c) => {
  const cacheImageId = c.req.param('cacheImageId').split('.')[0];
  const imageUrl = await redis.get(`bili:user_avatar:${cacheImageId}`);
  if(!imageUrl) {
    c.status(404);
    return c.text('Not Found');
  }
  const image = await fetchCachedImage(`bili:user_avatar:${cacheImageId}:bin`, imageUrl, 60 * 60 * 72);
  if(!image) {
    c.status(404);
    return c.text('Not Found');
  }
  return sendBinary(c, image);
});

export default app;
