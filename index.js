import { pathToFileURL } from 'node:url';
import { loadEnv, parseArgs } from './src/config.js';
import { createLiveSource, createSnapshotSource } from './src/api.js';
import { createCache, createLlmClient } from './src/extract.js';
import { runAll } from './src/pipeline.js';
import { buildReportModel, renderMarkdown, writeReport } from './src/report.js';
import { toIsoZ } from './src/time.js';

export async function main(argv, env) {
  let config;
  try {
    config = parseArgs(argv, env);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 2;
  }

  const source = config.offline ? createSnapshotSource(config.snapshotDir) : createLiveSource(config);
  const llm = config.openaiKey ? createLlmClient({ apiKey: config.openaiKey, model: config.model }) : null;
  const cache = createCache(config.cacheDir);

  let run;
  try {
    run = await runAll({ source, llm, cache, model: config.model, concurrency: config.concurrency });
  } catch (err) {
    console.error(`Error: could not fetch the fixture list (${err.reason ?? err.message})`);
    return 1;
  }

  const asOf = config.asOf ?? run.latestEvidenceAt ?? toIsoZ(new Date());
  const model = buildReportModel(run.results, { asOf, sourceKind: run.sourceKind });
  const { mdPath, jsonPath } = await writeReport(model, config.outDir);
  console.log(renderMarkdown(model));
  console.error(`Wrote ${mdPath} and ${jsonPath}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  process.exitCode = await main(process.argv.slice(2), process.env);
}
