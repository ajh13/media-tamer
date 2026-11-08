#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

function setting(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in GitHub Actions settings. See docs/signing.md.`);
  return value;
}

async function request(url, options, operation) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = result.error?.message ?? result.error ?? response.statusText;
    throw new Error(`${operation} failed (HTTP ${response.status}): ${reason}`);
  }
  return result;
}

async function publish(version) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
    throw new Error('Pass the extension manifest version to publish-chrome.mjs.');
  }
  const zip = await readFile(`dist/media_tamer-chrome-${version}.zip`);
  const publisher = encodeURIComponent(setting('CWS_PUBLISHER_ID'));
  const item = setting('CWS_EXTENSION_ID');
  if (!/^[a-p]{32}$/.test(item)) throw new Error('CWS_EXTENSION_ID must be a Chrome item ID.');

  const { access_token: token } = await request(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: setting('CWS_CLIENT_ID'),
        client_secret: setting('CWS_CLIENT_SECRET'),
        refresh_token: setting('CWS_REFRESH_TOKEN'),
      }),
    },
    'Chrome Web Store OAuth',
  );
  if (!token) throw new Error('Google did not return an access token.');

  const api = 'https://chromewebstore.googleapis.com';
  const name = `publishers/${publisher}/items/${item}`;
  const authorization = { Authorization: `Bearer ${token}` };
  const status = () =>
    request(`${api}/v2/${name}:fetchStatus`, { headers: authorization }, 'Check store status');
  const existing = await status();
  const alreadySubmitted = [
    existing.publishedItemRevisionStatus,
    existing.submittedItemRevisionStatus,
  ].some(
    (revision) =>
      ['PUBLISHED', 'PENDING_REVIEW'].includes(revision?.state) &&
      revision.distributionChannels?.some((channel) => channel.crxVersion === version),
  );
  if (alreadySubmitted) {
    console.log(`Chrome ${version} is already published or awaiting review.`);
    return;
  }
  if (existing.submittedItemRevisionStatus?.state === 'PENDING_REVIEW') {
    throw new Error('Another Chrome version is in review. Retry after that review finishes.');
  }

  const uploaded = await request(
    `${api}/upload/v2/${name}:upload`,
    {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/zip' },
      body: zip,
    },
    'Upload Chrome ZIP',
  );
  if (uploaded.crxVersion && uploaded.crxVersion !== version) {
    throw new Error(`Chrome received version ${uploaded.crxVersion}, expected ${version}.`);
  }

  // The API may return before asynchronous validation completes.
  let uploadState = uploaded.uploadState;
  for (let attempt = 0; /^(UPLOAD_)?IN_PROGRESS$/.test(uploadState) && attempt < 30; attempt++) {
    await delay(5000);
    uploadState = (await status()).lastAsyncUploadState;
  }
  if (uploadState !== 'SUCCEEDED') {
    throw new Error(`Chrome package upload did not succeed: ${uploadState ?? 'unknown state'}.`);
  }

  const result = await request(
    `${api}/v2/${name}:publish`,
    {
      method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
    },
    'Submit Chrome package for review',
  );
  if (!['PENDING_REVIEW', 'PUBLISHED'].includes(result.state)) {
    throw new Error(`Unexpected Chrome submission state: ${result.state ?? 'unknown state'}.`);
  }
  console.log(`Chrome ${version}: ${result.state}`);
}

publish(process.argv[2]).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
