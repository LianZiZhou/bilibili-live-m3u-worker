interface BiliLiveRoomDURL {
  url: string;
  length: number;
  order: number;
  stream_type: number;
  p2p_type: number;
}

interface BiliLiveRoomPlayUrlData {
  accept_quality: string;
  current_quality: 2 | 3 | 4;
  current_qn: number;
  current_qn_name: string;
  format: string;
  from: string;
  quality_description: string;

  durl: BiliLiveRoomDURL[];
}

interface BiliLiveRoomPlayUrlResponse {
  code: number;
  message: string;
  ttl: number;
  data?: BiliLiveRoomPlayUrlData;
}

interface XAPIBiliLiveRoomPlayUrlResponse {
  code: number;
  message: string;
  ttl: number;
  data?: XAPIBiliLiveRoomPlayUrlData;
}

interface XAPIBiliLiveRoomPlayUrlData {
  playurl_info: {
    playurl: {
      stream: {
        protocol_name: string;
        format: {
          format_name: string;
          codec: {
            codec_name: string;
            current_qn: number;
            base_url: string;
            url_info: {
              host: string;
              extra: string;
              stream_ttl: number;
            }[];
          }[];
        }[];
      }[];
    };
  }
}