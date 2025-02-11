const express = require('express');
const dayjs = require('dayjs');
const _ = require('lodash');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { validateHeader } = require('../middlewares/headers');
const syncer = require('../services/syncer/data');
const registry = require('../services/registry');
const queue = require('../queue');
const md5 = require('../helpers/md5');
const { cleanTags, routerCacheHelper } = require('../helpers/utils');

const router = express.Router();

const hasAnalytics = config.get('analytics:enabled');
const analyticsRetentionSec = config.get('analytics:retention_days') * 24 * 60 * 60;
const jobStatusCacheSec = config.get('settings:job_status_cache_min') * 60;
const limitPushWindowMsec = config.get('limits:push:window_sec') * 1000;
const limitPushMaxReq = config.get('limits:push:max_req') * 1;

/**
 * Get language translations
 *
 * @param {*} req
 * @param {*} res
 */
async function getContent(req, res) {
  // pattern is:
  // - token:lang:content
  // - token:lang:content[tag1,tag2]
  let key = `${req.token.project_token}:${req.params.lang_code}:content`;

  // parse tags filter
  let filter = {};
  const tags = cleanTags(_.get(req.query, 'filter.tags'));
  if (tags) {
    // update filter
    filter = {
      tags,
    };
    // add tags to key
    key = `${key}[${tags}]`;
  }
  const sentContent = await routerCacheHelper(
    req, res,
    key, filter,
    'getProjectLanguageTranslations', req.params.lang_code,
  );
  if (hasAnalytics && sentContent) {
    const clientId = md5(req.ip || 'unknown');

    const project = req.token.project_token;
    const lang = req.params.lang_code;
    const sdkVersion = (req.headers['x-native-sdk'] || 'unknown').replace(/ /g, '-');

    const dateDay = dayjs().format('YYYY-MM-DD');
    const keyDay = `analytics:${project}:${dateDay}`;
    if (await registry.addToSet(`${keyDay}:clients`, clientId, analyticsRetentionSec)) {
      registry.incr(`${keyDay}:lang:${lang}`, 1, analyticsRetentionSec);
      registry.incr(`${keyDay}:sdk:${sdkVersion}`, 1, analyticsRetentionSec);
      registry.addToSet(`${keyDay}:lang`, `${lang}`, analyticsRetentionSec);
      registry.addToSet(`${keyDay}:sdk`, `${sdkVersion}`, analyticsRetentionSec);
    }
  }
}

// ------------- Routes -------------

router.get('/:lang_code',
  validateHeader('public'),
  getContent);

router.post('/',
  validateHeader('private'),
  rateLimit({
    windowMs: limitPushWindowMsec,
    max: limitPushMaxReq,
    keyGenerator: (req) => req.token.project_token,
    message: {
      status: 429,
      message: 'Too many requests, please try again later.',
    },
  }),
  async (req, res) => {
    // authenticate before creating an push job
    const isAuthenticated = await syncer.verifyCredentials({ token: req.token });
    if (!isAuthenticated) {
      res.status(403).json({
        status: 403,
        message: 'Forbidden',
        details: 'Invalid credentials',
      });
      return;
    }

    // create a unique job id based on content
    const contentHash = md5(JSON.stringify(req.body));
    const key = `${req.token.project_token}:${contentHash}:push`;
    const jobId = md5(key);

    // check if job is already in the queue
    if (await queue.hasJob(key)) {
      res.status(409).json({
        status: 409,
        message: 'Another content upload is already in progress',
      });
      return;
    }

    // update job status
    await registry.set(`job:status:${jobId}`, {
      data: {
        status: 'pending',
      },
    }, jobStatusCacheSec);

    // add job to queue
    await queue.addJob(key, {
      type: 'syncer:push',
      key,
      jobId,
      token: req.token,
      payload: req.body,
    });

    // respond
    res.status(202).json({
      data: {
        id: jobId,
        links: {
          job: `/jobs/content/${jobId}`,
        },
      },
    });
  });

module.exports = router;
