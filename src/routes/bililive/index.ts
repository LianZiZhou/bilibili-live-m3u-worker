import { Hono } from 'hono';
import redis from "../../module/redis";

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
      'Cookie': 'SESSDATA=' + process.env.BILI_SESSDATA
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

export default app;