import url from 'url';
import https from 'http';
import gunzip from 'gunzip-maybe';
import LRUCache from 'lru-cache';

import bufferStream from './bufferStream.js';

// 包源路径数组，每次查找包都从所有路径查找，哪个先正确返回显示哪个
const sourceNpmRegistry = ['http://115.182.90.219:31449', 'https://registry.npmjs.org'];
// const npmRegistryURL =
//   // process.env.NPM_REGISTRY_URL || 'http://127.0.0.1:7001';

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

/* 
**  get函数请求
**  发起请求
**  将正确结果通过reject返回（后续Promise.All.catch中将正确结果输出）
*/
function get(options) {
  return new Promise((accept, reject) => {
    https.get(options, (result) => {
      if (result.statusCode === 200) {
        reject(result)
      }
      else {
        accept(result)
      }
    }).on('error', accept);
  });
}
/* 包名处理 */
function isScopedPackageName(packageName) {
  return packageName.startsWith('@');
}
/* 包名处理 */
function encodePackageName(packageName) {
  return isScopedPackageName(packageName)
    ? `@${encodeURIComponent(packageName.substring(1))}`
    : encodeURIComponent(packageName);
}

/* 
**获取包信息
*/
async function fetchPackageInfo(packageName, log, registryUrl) {
  const name = encodePackageName(packageName);
  const promiseall = []
  sourceNpmRegistry.map((vlaue) => {
    let infoURL = `${vlaue}/${name}`
    log.debug('Fetching package info for %s from %s', packageName, infoURL);
    let { hostname, pathname, port } = url.parse(infoURL);
    let options = {
      agent: agent,
      hostname: hostname,
      port: port,
      path: pathname,
      headers: {
        Accept: 'application/json'
      }
    };
    promiseall.push(get(options))
  }
  )

  let res = ''
  await Promise.all(promiseall)
    .then(async result => {
      let content = await bufferStream(result[1]).toString('utf-8');

      log.error(
        'Error fetching info for %s (status: %s,%s)',
        packageName,
        result[0].statusCode,
        result[1].statusCode
      );
      log.error(content);
    })
    .catch(result => {//当有返回值时才调用这里
      res = result
    })
  if (res.statusCode === 200) {
    return bufferStream(res).then(JSON.parse)
  }
  return null
}

async function fetchVersionsAndTags(packageName, log) {
  const info = await fetchPackageInfo(packageName, log)

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
  const info = await fetchPackageInfo(packageName, log)
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
  const promiseall = []
  sourceNpmRegistry.map((vlaue) => {
    let tarballURL = `${vlaue}/${packageName}/-/${tarballName}-${version}.tgz`
    // let tarballURL = `${vlaue}/${packageName}`
    let { hostname, pathname, port } = url.parse(tarballURL);
    let options = {
      agent: agent,
      hostname: hostname,
      port: port,
      path: pathname
    };
    promiseall.push(get(options))
  }
  )

  let res = ''
  /* Promise.all改造，获取最快得到正确结果的数据 */
  await Promise.all(promiseall).then(async result => {
    // let content = await bufferStream(result[0]).toString('utf-8');
    log.error(
      'Error fetching info for %s (status: %s)',
      packageName,
      result[0].statusCode
    );
    // log.error(content);
  })
    .catch(result => {//当有正确返回值时才调用这里
      res = result
    })

  // const res = await get(options);

  if (res.statusCode === 200) {
    const stream = res.pipe(gunzip());
    // stream.pause();
    return stream;
  }
  return null;
}
