const core = require("@actions/core");

const process = require("process");
const HttpClient = require("@actions/http-client").HttpClient;
const { createLogger, transports } = require("winston");
const LokiTransport = require("winston-loki");
const githubAPIUrl = "https://api.github.com";

export function getClient(ghToken) {
  return new HttpClient("gh-http-client", [], {
    headers: {
      Authorization: `token ${ghToken}`,
      "Content-Type": "application/json",
    },
  });
}

export async function fetchJobs(httpClient, repo, runId, allowList) {
  const url = `${githubAPIUrl}/repos/${repo}/actions/runs/${runId}/jobs`;
  const res = await httpClient.get(url);

  if (res.message.statusCode === undefined || res.message.statusCode >= 400) {
    throw new Error(`HTTP request failed: ${res.message.statusMessage}`);
  }

  const body = await res.readBody();
  const jobs = [];
  const all = allowList.length === 0;
  for (const j of JSON.parse(body).jobs) {
    // if there's an allow list, skip job accordingly
    if (!all && !allowList.includes(j.name)) {
      continue;
    }

    jobs.push({
      id: j.id,
      name: j.name,
    });
  }

  return jobs;
}

export async function fetchLogs(httpClient, repo, job) {
  const url = `${githubAPIUrl}/repos/${repo}/actions/jobs/${job.id}/logs`;
  const res = await httpClient.get(url);

  if (res.message.statusCode === undefined || res.message.statusCode >= 400) {
    throw new Error(`HTTP request failed: ${res.message.statusMessage}`);
  }

  const body = await res.readBody();
  return body.split("\n");
}

export function getCommaSeparatedInput(value) {
  let val = [];
  if (value !== "") {
    val = value.split(",");
    val = val.map((s) => s.trim());
  }

  return val;
}

export async function run() {
  try {
    // retrieve config params

    // Github repo token
    const repoToken = core.getInput("repo-token", { required: true });
    // List of jobs to collect logs from (all jobs when empty)
    const jobNames = core.getInput("job-names", { required: false });
    const allowList = getCommaSeparatedInput(jobNames);
    // LogQL Push endpoint
    const endpoint = core.getInput("endpoint", { required: false });
    // LogQL endpoints (when endpoint is not present)
    const addrValue = core.getInput("addresses", { required: false });
    const addresses = getCommaSeparatedInput(addrValue);
    // LogQL partition ID
    const partitionId = core.getInput("partition", { required: false });
    // logql user
    const username = core.getInput("username", { required: false });
    // logql pass
    const password = core.getInput("password", { required: false });

    // Ensure either endpoint or addresses are set
    if (endpoint === "" && addresses.length === 0) {
      throw new Error(
        "invalid configuration: please set either endpoint or addresses"
      );
    }

    // get an authenticated HTTP client for the GitHub API
    const client = getClient(repoToken);

    // get all the jobs for the current workflow
    const workflowId = process.env["GITHUB_RUN_ID"] || "";
    const repo = process.env["GITHUB_REPOSITORY"] || "";
    core.debug(`Allow listing ${allowList.length} jobs in repo ${repo}`);
    const jobs = await fetchJobs(client, repo, workflowId, allowList);

    const onConnectionError = (err) => {
      core.debug("Error at connecting with logs endpoint\n", err);
    };
    const lokiBasicAuth = () => {
      if (username && password) {
        return `${username}:${password}`;
      }
      return "";
    };
    const options = {
      transports: [
        new LokiTransport({
          host: endpoint || addresses[0],
          gracefulShutdown: true,
          onConnectionError: onConnectionError,
          timeout: 30000,
          lokiBasicAuth: lokiBasicAuth(),
        }),
      ],
    };
    const logger = createLogger(options);

    // get the logs for each job
    core.debug(`Getting logs for ${jobs.length} jobs`);
    for (const j of jobs) {
      const lines = await fetchLogs(client, repo, j);
      core.debug(`Fetched ${lines.length} lines for job ${j.name}`);
      for (const l of lines) {
        core.debug(`${l}`);
        logger.info(l);
      }
    }
    logger.clear();
  } catch (e) {
    core.setFailed(`Run failed: ${e}`);
  }
}

await run();
