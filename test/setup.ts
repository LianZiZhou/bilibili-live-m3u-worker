// isolate tests from local config / data
process.env.CONFIG_PATH = './test/nonexistent-config.json';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
process.env.YT_SOURCE = 'local';
process.env.YT_PROXY = '';
process.env.SERVICE_URL = '';
process.env.YT_CHANNELS = 'UCtesttesttesttesttest01:测试频道,UCtesttesttesttesttest02';
