import Redis from 'ioredis';
import config from '../config';

const redis = new Redis(config.redisUrl);

redis.on('error', (err) => {
  console.log('Redis ' + err);
});

redis.on('ready', () => {
  console.log('Redis Ready');
});

redis.on('connect', () => {
  console.log('Redis Connected');
});

export default redis;