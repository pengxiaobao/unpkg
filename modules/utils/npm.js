import url from 'url';
import https from 'http';
import gunzip from 'gunzip-maybe';
import LRUCache from 'lru-cache';

import bufferStream from './bufferStream.js';

// 如果在npmRegistryURL找不到，就去sourceNpmRegistry再找一遍
const sourceNpmRegistry = 'https://registry.npmjs.org';
const npmRegistryURL =
  process.env.NPM_REGISTRY_URL || 'http://127.0.0.1:7001';

const agent = new https.Agent({
  keepAlive: true
});

const oneMegabyte = 1024 * 1024;
const oneSecond = 1000;
const oneMinute = oneSecond * 60;

const cache = new LRUCache({
  max: oneMegabyte * 40,
  length: Buffer.byteLength,
  maxAge: oneSecond
});

const notFound = '';

function get(options) {
  return new Promise((accept, reject) => {
    https.get(options, accept).on('error', reject);
  });
}

function isScopedPackageName(packageName) {
  return packageName.startsWith('@');
}

function encodePackageName(packageName) {
  return isScopedPackageName(packageName)
    ? `@${encodeURIComponent(packageName.substring(1))}`
    : encodeURIComponent(packageName);
}

async function fetchPackageInfo(packageName, log, registryUrl) {
  const name = encodePackageName(packageName);
  const infoURL = `${registryUrl || npmRegistryURL}/${name}`;

  log.debug('Fetching package info for %s from %s', packageName, infoURL);

  const { hostname, pathname, port } = url.parse(infoURL);
  const options = {
    agent: agent,
    hostname: hostname,
    port: port,
    path: pathname,
    headers: {
      Accept: 'application/json'
    }
  };

  const res = await get(options);

  if (res.statusCode === 200) {
    return bufferStream(res).then(JSON.parse);
  }

  if (res.statusCode === 404) {
    if(registryUrl !== npmRegistryURL){
      const towRes = await fetchPackageInfo(packageName, log, sourceNpmRegistry)
      return towRes;
    }
    return null;
  }

  const content = (await bufferStream(res)).toString('utf-8');

  log.error(
    'Error fetching info for %s (status: %s)',
    packageName,
    res.statusCode
  );
  log.error(content);

  return null;
}

async function fetchVersionsAndTags(packageName, log) {
  const info = await fetchPackageInfo(packageName, log);
  return info && info.versions
    ? { versions: Object.keys(info.versions), tags: info['dist-tags'] }
    : null;
}

/**
 * Returns an object of available { versions, tags }.
 * Uses a cache to avoid over-fetching from the registry.
 */
export async function getVersionsAndTags(packageName, log) {
  const cacheKey = `versions-${packageName}`;
  const cacheValue = cache.get(cacheKey);

  if (cacheValue != null) {
    return cacheValue === notFound ? null : JSON.parse(cacheValue);
  }

  const value = await fetchVersionsAndTags(packageName, log);

  if (value == null) {
    cache.set(cacheKey, notFound, 5 * oneMinute);
    return null;
  }

  cache.set(cacheKey, JSON.stringify(value), oneMinute);
  return value;
}

// All the keys that sometimes appear in package info
// docs that we don't need. There are probably more.
const packageConfigExcludeKeys = [
  'browserify',
  'bugs',
  'directories',
  'engines',
  'files',
  'homepage',
  'keywords',
  'maintainers',
  'scripts'
];

function cleanPackageConfig(config) {
  return Object.keys(config).reduce((memo, key) => {
    if (!key.startsWith('_') && !packageConfigExcludeKeys.includes(key)) {
      memo[key] = config[key];
    }

    return memo;
  }, {});
}

async function fetchPackageConfig(packageName, version, log) {
  const info = await fetchPackageInfo(packageName, log);
  return info && info.versions && version in info.versions
    ? cleanPackageConfig(info.versions[version])
    : null;
}

/**
 * Returns metadata about a package, mostly the same as package.json.
 * Uses a cache to avoid over-fetching from the registry.
 */
export async function getPackageConfig(packageName, version, log) {
  const cacheKey = `config-${packageName}-${version}`;
  const cacheValue = cache.get(cacheKey);

  if (cacheValue != null) {
    return cacheValue === notFound ? null : JSON.parse(cacheValue);
  }

  const value = await fetchPackageConfig(packageName, version, log);

  if (value == null) {
    cache.set(cacheKey, notFound, 5 * oneMinute);
    return null;
  }

  cache.set(cacheKey, JSON.stringify(value), oneMinute);
  return value;
}

/**
 * Returns a stream of the tarball'd contents of the given package.
 */
export async function getPackage(packageName, version, log, registryUrl) {
  const tarballName = isScopedPackageName(packageName)
    ? packageName.split('/')[1]
    : packageName;
  const tarballURL = `${registryUrl || npmRegistryURL}/${packageName}/-/${tarballName}-${version}.tgz`;

  log.debug('Fetching package for %s from %s', packageName, tarballURL);

  const { hostname, pathname, port } = url.parse(tarballURL);
  const options = {
    agent: agent,
    hostname: hostname,
    port: port,
    path: pathname
  };

  const res = await get(options);

  if (res.statusCode === 200) {
    const stream = res.pipe(gunzip());
    // stream.pause();
    return stream;
  }

  if (res.statusCode === 404) {
    if(registryUrl !== npmRegistryURL){
      const towRes = await getPackage(packageName, version, log, sourceNpmRegistry)
      return towRes
    }
    return null;
  }

  const content = (await bufferStream(res)).toString('utf-8');

  log.error(
    'Error fetching tarball for %s@%s (status: %s)',
    packageName,
    version,
    res.statusCode
  );
  log.error(content);

  return null;
}
