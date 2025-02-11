const config = require('../../../../config');
const logger = require('../../../../logger');
const { createClient } = require('../../../../helpers/ioredis');

const prefix = config.get('cache:redis:prefix') || '';
const expireSec = config.get('cache:redis:expire_min') * 60;
const client = createClient();

/**
 * Convert a user key to Redis key with prefix included
 *
 * @param {String} key
 * @returns {String}
 */
function keyToRedis(key) {
  return `${prefix}${key}`;
}

/**
 * @implements {delContent}
 */
function delContent(key) {
  return new Promise((resolve) => {
    client.del(keyToRedis(key), (err) => {
      if (err) {
        logger.warn(`[Redis] Cache deletion failed for ${key} key`);
      } else {
        logger.info(`[Redis] Cache deleted for ${key} key`);
      }
      resolve();
    });
  });
}

/**
 * @implements {getContent}
 */
function getContent(key) {
  return new Promise((resolve, reject) => {
    client.get(keyToRedis(key), (err, payload) => {
      if (err) {
        reject(err);
      } else if (!payload) {
        resolve({
          data: null,
        });
      } else {
        const parsedPayload = JSON.parse(payload);
        resolve({
          data: parsedPayload.data,
        });
      }
    });
  });
}

/**
 * @implements {setContent}
 */
function setContent(key, data) {
  return new Promise((resolve, reject) => {
    const payload = {
      data,
    };
    client.set(keyToRedis(key), JSON.stringify(payload), 'EX', expireSec, (err) => {
      if (err) {
        logger.error(`[Redis] Failed to set cache content for ${key} key`);
        reject(err);
      } else {
        logger.info(`[Redis] Cache set for ${key} key`);
        resolve({
          location: `cache://${key}`,
        });
      }
    });
  });
}

/**
 * @implements {init}
 */
async function init() {
  // no-op
}

/**
 * @implements {destroy}
 */
async function destroy() {
  // no-op
}

module.exports = {
  init,
  destroy,
  delContent,
  getContent,
  setContent,
};
