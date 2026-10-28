import { toIsoZ } from './iso.js';

const API_BASE = 'https://everyday-sim-463015353641.us-east1.run.app/api/challenge';

export function loadEnv(path = '.env') {
  try {
    process.loadEnvFile(path);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export function parseArgs(argv, env) {
  const config = {
    asOf: null,
    offline: false,
    outDir: 'output',
    apiBase: API_BASE,
    openaiKey: env.OPENAI_API_KEY || null,
    model: env.OPENAI_MODEL || 'gpt-4.1-mini',
    snapshotDir: 'data/snapshot',
    cacheDir: 'data/llm-cache',
    concurrency: 3,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--offline') {
      config.offline = true;
    } else if (flag === '--out' || flag === '--as-of') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--out') {
        config.outDir = value;
      } else {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) throw new Error(`--as-of must be an ISO time, got "${value}"`);
        config.asOf = toIsoZ(date);
      }
    } else {
      throw new Error(`unknown option ${flag}`);
    }
  }
  return config;
}
