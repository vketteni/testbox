const axios = require('axios');
const { createClient } = require('redis');
const client = require('prom-client');
const cron = require('cron');
const winston = require('winston');

// Configuration
const config = {
  hubspotApiUrl: process.env.HUBSPOT_API_URL || 'http://localhost:3001',
  databoxApiUrl: process.env.DATABOX_API_URL || 'http://localhost:3003',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  databoxToken: process.env.DATABOX_TOKEN || 'direct-polling-token',
  syncInterval: process.env.SYNC_INTERVAL || '*/5 * * * *', // Every 5 minutes
  batchSize: parseInt(process.env.BATCH_SIZE) || 100,
  maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
  retryDelay: parseInt(process.env.RETRY_DELAY) || 5000
};

// Logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: '/app/data/direct-polling.log' })
  ]
});

// Prometheus metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const syncDuration = new client.Histogram({
  name: 'direct_polling_sync_duration_seconds',
  help: 'Duration of sync operations',
  labelNames: ['sync_type', 'status'],
  registers: [register]
});

const apiRequests = new client.Counter({
  name: 'direct_polling_api_requests_total',
  help: 'Total API requests made',
  labelNames: ['service', 'endpoint', 'status'],
  registers: [register]
});

const recordsProcessed = new client.Counter({
  name: 'direct_polling_records_processed_total',
  help: 'Total records processed',
  labelNames: ['object_type', 'operation'],
  registers: [register]
});

const syncErrors = new client.Counter({
  name: 'direct_polling_sync_errors_total',
  help: 'Total sync errors',
  labelNames: ['error_type', 'endpoint'],
  registers: [register]
});

// Redis client
let redis;

class DirectPollingSync {
  constructor() {
    this.isRunning = false;
    this.lastSyncStates = new Map();
  }

  async initialize() {
    // Connect to Redis
    redis = createClient({ url: config.redisUrl });
    redis.on('error', (err) => logger.error('Redis error:', err));
    await redis.connect();
    logger.info('Connected to Redis');

    // Load last sync states
    await this.loadSyncStates();
    
    // Start periodic sync
    this.startPeriodicSync();
    
    logger.info('Direct Polling Sync initialized');
  }

  async loadSyncStates() {
    try {
      const states = await redis.hGetAll('direct_polling:sync_states');
      for (const [key, value] of Object.entries(states)) {
        this.lastSyncStates.set(key, JSON.parse(value));
      }
      logger.info(`Loaded ${this.lastSyncStates.size} sync states`);
    } catch (error) {
      logger.warn('Could not load sync states:', error.message);
    }
  }

  async saveSyncState(objectType, state) {
    this.lastSyncStates.set(objectType, state);
    await redis.hSet('direct_polling:sync_states', objectType, JSON.stringify(state));
  }

  startPeriodicSync() {
    const job = new cron.CronJob(config.syncInterval, () => {
      if (!this.isRunning) {
        this.performSync().catch(error => {
          logger.error('Sync failed:', error);
          syncErrors.inc({ error_type: 'sync_failure', endpoint: 'general' });
        });
      }
    });
    job.start();
    logger.info(`Scheduled sync every ${config.syncInterval}`);
  }

  async performSync() {
    if (this.isRunning) {
      logger.warn('Sync already running, skipping');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    
    try {
      logger.info('Starting sync operation');
      
      // Sync companies (main focus for this benchmark)
      await this.syncCompanies();
      
      // Could add contacts, deals, etc. here
      
      const duration = (Date.now() - startTime) / 1000;
      syncDuration.observe({ sync_type: 'full', status: 'success' }, duration);
      
      logger.info(`Sync completed in ${duration.toFixed(2)}s`);
      
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      syncDuration.observe({ sync_type: 'full', status: 'error' }, duration);
      
      logger.error('Sync failed:', error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  async syncCompanies() {
    const objectType = 'companies';
    const lastState = this.lastSyncStates.get(objectType) || { 
      lastSyncTime: null, 
      lastCursor: null,
      totalProcessed: 0
    };

    let hasMore = true;
    let after = lastState.lastCursor;
    let totalProcessed = 0;
    let batchCount = 0;

    while (hasMore) {
      try {
        // Fetch companies from HubSpot with pagination
        const companies = await this.fetchCompaniesFromHubSpot(after, config.batchSize);
        
        if (!companies.results || companies.results.length === 0) {
          break;
        }

        // Filter for recently modified records (if not initial sync)
        let filteredCompanies = companies.results;
        if (lastState.lastSyncTime) {
          filteredCompanies = companies.results.filter(company => {
            const updatedAt = new Date(company.updatedAt);
            return updatedAt > new Date(lastState.lastSyncTime);
          });
        }

        if (filteredCompanies.length > 0) {
          // Send to Databox
          await this.sendCompaniesToDatabox(filteredCompanies);
          totalProcessed += filteredCompanies.length;
          
          recordsProcessed.inc({ object_type: 'company', operation: 'sync' }, filteredCompanies.length);
        }

        // Update pagination
        hasMore = !!companies.paging?.next;
        after = companies.paging?.next?.after;
        batchCount++;

        // Rate limiting - respect HubSpot's limits
        if (batchCount % 10 === 0) {
          logger.info(`Processed ${batchCount} batches, ${totalProcessed} companies updated`);
          await this.sleep(1000); // 1 second pause every 10 batches
        }

      } catch (error) {
        logger.error(`Error syncing companies batch (after: ${after}):`, error.message);
        syncErrors.inc({ error_type: 'api_error', endpoint: 'companies' });
        
        // Retry logic
        await this.sleep(config.retryDelay);
        throw error;
      }
    }

    // Update sync state
    await this.saveSyncState(objectType, {
      lastSyncTime: new Date().toISOString(),
      lastCursor: null, // Reset for next full sync
      totalProcessed: lastState.totalProcessed + totalProcessed
    });

    logger.info(`Companies sync completed: ${totalProcessed} records processed`);
  }

  async fetchCompaniesFromHubSpot(after = null, limit = 100) {
    const params = new URLSearchParams({
      limit: limit.toString(),
      properties: 'name,domain,industry,founded_year,hs_lastmodifieddate'
    });
    
    if (after) {
      params.append('after', after);
    }

    const url = `${config.hubspotApiUrl}/crm/v3/objects/companies?${params}`;
    
    try {
      const response = await axios.get(url, {
        timeout: 30000,
        validateStatus: (status) => status < 500
      });

      apiRequests.inc({ 
        service: 'hubspot', 
        endpoint: 'companies', 
        status: response.status.toString() 
      });

      if (response.status === 429) {
        // Rate limited, wait and retry
        const retryAfter = parseInt(response.headers['retry-after'] || '60');
        logger.warn(`Rate limited, waiting ${retryAfter}s`);
        await this.sleep(retryAfter * 1000);
        return this.fetchCompaniesFromHubSpot(after, limit);
      }

      if (response.status >= 400) {
        throw new Error(`HubSpot API error: ${response.status} ${response.statusText}`);
      }

      return response.data;
      
    } catch (error) {
      apiRequests.inc({ 
        service: 'hubspot', 
        endpoint: 'companies', 
        status: 'error' 
      });
      
      if (error.code === 'ECONNABORTED') {
        throw new Error('HubSpot API timeout');
      }
      throw error;
    }
  }

  async sendCompaniesToDatabox(companies) {
    // Convert HubSpot company data to Databox format
    const databoxData = companies.map(company => {
      const data = {
        date: company.updatedAt || new Date().toISOString(),
        objectId: company.id
      };

      // Convert properties to metrics (using $ prefix for Databox)
      if (company.properties.founded_year && !isNaN(company.properties.founded_year)) {
        data.$company_age = new Date().getFullYear() - parseInt(company.properties.founded_year);
      }
      
      // Add categorical metrics as attributes
      if (company.properties.industry) {
        data.industry = company.properties.industry;
      }
      
      if (company.properties.name) {
        data.company_name = company.properties.name;
      }

      // Example numeric metrics
      data.$companies_updated = 1; // Count metric
      
      return data;
    });

    const payload = {
      data: databoxData,
      source: 'HubSpot-DirectPolling'
    };

    try {
      const response = await axios.post(config.databoxApiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-token': config.databoxToken
        },
        timeout: 30000
      });

      apiRequests.inc({ 
        service: 'databox', 
        endpoint: 'push', 
        status: response.status.toString() 
      });

      logger.debug(`Sent ${companies.length} companies to Databox`);
      return response.data;
      
    } catch (error) {
      apiRequests.inc({ 
        service: 'databox', 
        endpoint: 'push', 
        status: 'error' 
      });
      
      logger.error('Failed to send data to Databox:', error.message);
      throw error;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getMetrics() {
    return await register.metrics();
  }

  async getStats() {
    return {
      solution: 'Direct Polling',
      isRunning: this.isRunning,
      lastSyncStates: Object.fromEntries(this.lastSyncStates),
      config: {
        syncInterval: config.syncInterval,
        batchSize: config.batchSize
      }
    };
  }

  async shutdown() {
    logger.info('Shutting down Direct Polling Sync');
    if (redis) {
      await redis.quit();
    }
  }
}

// Express server for monitoring
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

const syncService = new DirectPollingSync();

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    solution: 'Direct Polling',
    timestamp: new Date().toISOString()
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await syncService.getMetrics());
});

app.get('/stats', async (req, res) => {
  res.json(await syncService.getStats());
});

app.post('/sync/trigger', async (req, res) => {
  try {
    if (syncService.isRunning) {
      return res.status(409).json({ error: 'Sync already running' });
    }
    
    // Trigger manual sync
    syncService.performSync().catch(error => {
      logger.error('Manual sync failed:', error);
    });
    
    res.json({ message: 'Sync triggered' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully');
  await syncService.shutdown();
  process.exit(0);
});

// Start the service
async function start() {
  try {
    await syncService.initialize();
    
    app.listen(port, () => {
      logger.info(`Direct Polling Solution running on port ${port}`);
    });
    
  } catch (error) {
    logger.error('Failed to start service:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { DirectPollingSync };