import Redis from 'ioredis';
import fs = require('fs');

import dotenv = require('dotenv');

dotenv.config();

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

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