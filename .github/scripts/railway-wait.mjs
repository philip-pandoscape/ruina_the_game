// Waits for a Railway deployment of the game to go live, then checks it answers.
//
//   RAILWAY_TOKEN=<the environment's project token> node .github/scripts/railway-wait.mjs <since>
//
// `railway up --ci` returns once the image is built; this follows the deployment it started (the
// newest one created after <since>, in Unix seconds) until Railway says it's live or failed, then
// asks the game's /api/health. Writes url=https://... to $GITHUB_OUTPUT for the environment link.

import { appendFileSync } from 'node:fs';

const SERVICE = 'ruina_the_game';
const since = Number(process.argv[2] ?? 0) * 1000;
const token = process.env.RAILWAY_TOKEN;
if (!token) throw new Error('RAILWAY_TOKEN is not set');

async function gql(query, variables = {}) {
  const r = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Project-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map((e) => e.message).join('; '));
  return j.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { projectToken: t } = await gql('{ projectToken { projectId environmentId } }');
const { project } = await gql('query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }', { id: t.projectId });
const service = project.services.edges.map((e) => e.node).find((s) => s.name === SERVICE);
if (!service) throw new Error(`no service named ${SERVICE} in this project`);

const LIVE = new Set(['SUCCESS']);
const DEAD = new Set(['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);
const deadline = Date.now() + 20 * 60_000;
let deployment = null;
let last = '';
while (Date.now() < deadline) {
  const { deployments } = await gql(
    'query($input: DeploymentListInput!) { deployments(first: 5, input: $input) { edges { node { id status createdAt } } } }',
    { input: { projectId: t.projectId, environmentId: t.environmentId, serviceId: service.id } },
  );
  deployment = deployments.edges.map((e) => e.node).find((d) => Date.parse(d.createdAt) >= since - 5000) ?? null;
  const status = deployment?.status ?? 'not started';
  if (status !== last) console.log(`deployment ${deployment?.id ?? ''}: ${status}`);
  last = status;
  if (LIVE.has(status)) break;
  if (DEAD.has(status)) throw new Error(`the deployment ended ${status}; see its logs on Railway`);
  await sleep(5000);
}
if (!deployment || !LIVE.has(deployment.status)) throw new Error('timed out waiting for the deployment');

const { environment } = await gql(
  'query($id: String!) { environment(id: $id) { serviceInstances { edges { node { serviceId domains { serviceDomains { domain } customDomains { domain } } } } } } }',
  { id: t.environmentId },
);
const instance = environment.serviceInstances.edges.map((e) => e.node).find((i) => i.serviceId === service.id);
const domain = instance?.domains.customDomains[0]?.domain ?? instance?.domains.serviceDomains[0]?.domain;
if (!domain) throw new Error('the game has no public domain in this environment');
const url = `https://${domain}`;

for (let i = 0; i < 24; i++) {
  try {
    const r = await fetch(`${url}/api/health`);
    const health = await r.json();
    if (r.ok && health.ok && health.database) {
      console.log(`live at ${url}: ${JSON.stringify(health)}`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\n`);
      process.exit(0);
    }
    console.log(`not healthy yet: ${r.status} ${JSON.stringify(health)}`);
  } catch (e) {
    console.log(`not answering yet: ${e.message}`);
  }
  await sleep(5000);
}
throw new Error(`${url}/api/health never reported healthy with a database`);
