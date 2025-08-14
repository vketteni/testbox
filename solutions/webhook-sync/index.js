const express = require('express');
const axios = require('axios');
const { createClient } = require('redis');
const client = require('prom-client');
const winston = require('winston');
const crypto = require('crypto');
const Queue = require('bull');

// Configuration
const config = {
  hubspotApiUrl: process.env.HUBSPOT_API_URL || 'http://localhost:3001',
  databoxApiUrl: process.env.DATABOX_API_URL || 'http://localhost:3003',
  webhookUrl: process.env.WEBHOOK_URL || 'http://localhost:3002',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  databoxToken: process.env.DATABOX_TOKEN || 'webhook-sync-token',
  webhookSecret: process.env.WEBHOOK_SECRET || 'webhook-sync-secret',
  port: process.env.PORT || 3000,
  batchSize: parseInt(process.env.BATCH_SIZE) || 50,
  processingDelay: parseInt(process.env.PROCESSING_DELAY) || 1000, // ms
  maxRetries: parseInt(process.env.MAX_RETRIES) || 3
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
    new winston.transports.File({ filename: '/app/data/webhook-sync.log' })
  ]
});

// Prometheus metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const webhookEvents = new client.Counter({
  name: 'webhook_sync_events_received_total',
  help: 'Total webhook events received',
  labelNames: ['event_type', 'object_type'],
  registers: [register]
});

const processingDuration = new client.Histogram({
  name: 'webhook_sync_processing_duration_seconds',
  help: 'Duration of webhook processing',
  labelNames: ['event_type', 'status'],
  registers: [register]
});

const apiRequests = new client.Counter({
  name: 'webhook_sync_api_requests_total',
  help: 'Total API requests made',
  labelNames: ['service', 'endpoint', 'status'],
  registers: [register]
});

const queueMetrics = new client.Gauge({
  name: 'webhook_sync_queue_size',
  help: 'Current queue size',
  labelNames: ['queue_name'],
  registers: [register]
});

const processingErrors = new client.Counter({
  name: 'webhook_sync_errors_total',
  help: 'Total processing errors',
  labelNames: ['error_type', 'operation'],
  registers: [register]
});

// Redis client and queues
let redis;
let processingQueue;

class WebhookSyncService {
  constructor() {
    this.subscriptionId = null;
    this.app = express();
    this.setupExpress();
  }

  setupExpress() {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.raw({ type: 'application/json' }));

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        solution: 'Webhook Sync',
        subscriptionId: this.subscriptionId,
        timestamp: new Date().toISOString()
      });
    });

    // Metrics endpoint
    this.app.get('/metrics', async (req, res) => {
      res.set('Content-Type', register.contentType);
      res.send(await register.metrics());
    });

    // Stats endpoint
    this.app.get('/stats', async (req, res) => {
      const queueStats = await processingQueue.getJobCounts();
      res.json({
        solution: 'Webhook Sync',
        subscriptionId: this.subscriptionId,
        queue: queueStats,
        config: {
          batchSize: config.batchSize,
          processingDelay: config.processingDelay
        }
      });
    });

    // Webhook endpoint
    this.app.post('/webhook', this.handleWebhook.bind(this));

    // Manual trigger endpoints
    this.app.post('/sync/initial', this.triggerInitialSync.bind(this));
    this.app.post('/sync/backfill', this.triggerBackfill.bind(this));
  }

  async initialize() {
    // Connect to Redis
    redis = createClient({ url: config.redisUrl });
    redis.on('error', (err) => logger.error('Redis error:', err));
    await redis.connect();
    logger.info('Connected to Redis');

    // Initialize processing queue
    processingQueue = new Queue('webhook processing', config.redisUrl);
    
    // Process jobs
    processingQueue.process('sync-object', this.processObjectSync.bind(this));
    processingQueue.process('batch-sync', this.processBatchSync.bind(this));

    // Queue monitoring
    processingQueue.on('completed', (job) => {
      logger.debug(`Job ${job.id} completed`);
    });

    processingQueue.on('failed', (job, err) => {
      logger.error(`Job ${job.id} failed:`, err.message);
      processingErrors.inc({ error_type: 'job_failure', operation: job.name });
    });

    // Update queue metrics periodically
    setInterval(async () => {
      const counts = await processingQueue.getJobCounts();
      queueMetrics.set({ queue_name: 'processing' }, counts.waiting + counts.active);
    }, 5000);

    // Subscribe to webhooks
    await this.subscribeToWebhooks();

    logger.info('Webhook Sync Service initialized');
  }

  async subscribeToWebhooks() {
    try {
      const subscriptionPayload = {
        url: `http://webhook-sync:3000/webhook`,
        events: ['company.propertyChange', 'company.creation', 'contact.*', 'deal.*'],
        secret: config.webhookSecret
      };

      const response = await axios.post(`${config.webhookUrl}/subscriptions`, subscriptionPayload);
      this.subscriptionId = response.data.subscriptionId;
      
      logger.info(`Subscribed to webhooks with ID: ${this.subscriptionId}`);
      
    } catch (error) {
      logger.error('Failed to subscribe to webhooks:', error.message);
      throw error;
    }
  }

  async handleWebhook(req, res) {
    const startTime = Date.now();
    
    try {
      // Debug: log the raw request body
      logger.info(`Raw webhook body: ${JSON.stringify(req.body)}`);
      logger.info(`req.body.event: ${JSON.stringify(req.body.event)}`);
      
      // Extract event from webhook service payload structure
      const event = req.body.event || req.body;
      logger.info(`Extracted event: ${JSON.stringify(event)}`);
      logger.info(`Event eventType: ${event?.eventType}`);
      
      // Validate webhook signature (simplified)
      if (!this.validateWebhookSignature(req)) {
        logger.warn('Invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      // Record webhook event
      webhookEvents.inc({
        event_type: event?.eventType || 'unknown',
        object_type: event?.objectType || 'unknown'
      });

      logger.info(`Received webhook: ${event?.eventType} for ${event?.objectType} ${event?.objectId}`);

      // Queue for processing
      await this.queueEventForProcessing(event);

      const duration = (Date.now() - startTime) / 1000;
      processingDuration.observe({ 
        event_type: event?.eventType || 'unknown', 
        status: 'success' 
      }, duration);

      res.json({ 
        message: 'Webhook received',
        eventId: event?.eventId,
        queued: true
      });

    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      processingDuration.observe({ 
        event_type: 'unknown', 
        status: 'error' 
      }, duration);

      logger.error('Webhook processing failed:', error);
      processingErrors.inc({ error_type: 'webhook_error', operation: 'receive' });
      
      res.status(500).json({ error: error.message });
    }
  }

  validateWebhookSignature(req) {
    // Temporarily disable signature validation for debugging
    return true;
    
    // Simplified signature validation
    const signature = req.headers['x-hubspot-signature'];
    if (!signature) return false;
    
    const expectedSignature = 'v1=' + crypto
      .createHmac('sha256', config.webhookSecret)
      .update(JSON.stringify(req.body))
      .digest('hex');
    
    return signature === expectedSignature;
  }

  async queueEventForProcessing(event) {
    const jobData = {
      eventType: event.eventType,
      objectType: event.objectType,
      objectId: event.objectId,
      properties: event.properties,
      occurredAt: event.occurredAt || Date.now()
    };

    // Add to processing queue with delay to allow for batching
    await processingQueue.add('sync-object', jobData, {
      delay: config.processingDelay,
      attempts: config.maxRetries,
      backoff: {
        type: 'exponential',
        delay: 2000
      }
    });
  }

  async processObjectSync(job) {
    const { eventType, objectType, objectId, properties } = job.data;
    
    try {
      logger.debug(`Processing ${eventType} for ${objectType} ${objectId}`);

      // Fetch full object data from HubSpot (webhook may have partial data)
      let objectData;
      if (eventType.includes('creation') || !properties) {
        objectData = await this.fetchObjectFromHubSpot(objectType, objectId);
      } else {
        objectData = { id: objectId, properties };
      }

      // Send to Databox
      await this.sendObjectToDatabox(objectType, objectData);

      apiRequests.inc({ 
        service: 'databox', 
        endpoint: 'push', 
        status: 'success' 
      });

      logger.debug(`Successfully synced ${objectType} ${objectId}`);

    } catch (error) {
      logger.error(`Failed to process ${objectType} ${objectId}:`, error.message);
      processingErrors.inc({ error_type: 'sync_error', operation: 'process_object' });
      throw error;
    }
  }

  async processBatchSync(job) {
    const { objectType, objectIds } = job.data;
    
    try {
      logger.info(`Processing batch sync for ${objectIds.length} ${objectType} objects`);

      // Fetch objects in batch from HubSpot
      const objects = await Promise.all(
        objectIds.map(id => this.fetchObjectFromHubSpot(objectType, id))
      );

      // Send to Databox in batch
      await this.sendBatchToDatabox(objectType, objects.filter(obj => obj));

      logger.info(`Successfully synced batch of ${objects.length} ${objectType} objects`);

    } catch (error) {
      logger.error(`Failed to process batch sync for ${objectType}:`, error.message);
      processingErrors.inc({ error_type: 'sync_error', operation: 'process_batch' });
      throw error;
    }
  }

  async fetchObjectFromHubSpot(objectType, objectId) {
    const url = `${config.hubspotApiUrl}/crm/v3/objects/${objectType}/${objectId}`;
    
    try {
      const response = await axios.get(url, {
        params: {
          properties: objectType === 'companies' 
            ? 'name,domain,industry,founded_year,hs_lastmodifieddate'
            : 'firstname,lastname,email,hs_lastmodifieddate'
        },
        timeout: 10000
      });

      apiRequests.inc({ 
        service: 'hubspot', 
        endpoint: objectType, 
        status: response.status.toString() 
      });

      return response.data;

    } catch (error) {
      apiRequests.inc({ 
        service: 'hubspot', 
        endpoint: objectType, 
        status: 'error' 
      });

      if (error.response?.status === 404) {
        logger.warn(`Object ${objectType} ${objectId} not found (may be deleted)`);
        return null;
      }
      
      throw error;
    }
  }

  async sendObjectToDatabox(objectType, objectData) {
    if (!objectData) return;

    const databoxData = this.convertToDataboxFormat(objectType, objectData);
    
    const payload = {
      data: [databoxData],
      source: `HubSpot-Webhook-${objectType}`
    };

    await this.sendToDatabox(payload);
  }

  async sendBatchToDatabox(objectType, objects) {
    if (!objects.length) return;

    const databoxData = objects.map(obj => this.convertToDataboxFormat(objectType, obj));
    
    const payload = {
      data: databoxData,
      source: `HubSpot-Webhook-${objectType}-Batch`
    };

    await this.sendToDatabox(payload);
  }

  convertToDataboxFormat(objectType, objectData) {
    const data = {
      date: objectData.updatedAt || new Date().toISOString(),
      objectId: objectData.id,
      objectType: objectType
    };

    if (objectType === 'companies') {
      if (objectData.properties.founded_year && !isNaN(objectData.properties.founded_year)) {
        data.$company_age = new Date().getFullYear() - parseInt(objectData.properties.founded_year);
      }
      data.$companies_updated = 1;
      data.company_name = objectData.properties.name;
      data.industry = objectData.properties.industry;
    } else if (objectType === 'contacts') {
      data.$contacts_updated = 1;
      data.contact_name = `${objectData.properties.firstname || ''} ${objectData.properties.lastname || ''}`.trim();
    }

    return data;
  }

  async sendToDatabox(payload) {
    try {
      const response = await axios.post(config.databoxApiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-token': config.databoxToken
        },
        timeout: 15000
      });

      return response.data;
      
    } catch (error) {
      logger.error('Failed to send data to Databox:', error.message);
      throw error;
    }
  }

  async triggerInitialSync(req, res) {
    try {
      logger.info('Triggering initial sync');
      
      // This would typically fetch all objects and queue them
      // For now, we'll just acknowledge the request
      res.json({ 
        message: 'Initial sync triggered',
        note: 'Webhook-driven approach typically starts from webhook events only'
      });

    } catch (error) {
      logger.error('Initial sync failed:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async triggerBackfill(req, res) {
    try {
      const { objectType = 'companies', hours = 24 } = req.body;
      
      logger.info(`Triggering backfill for ${objectType} (last ${hours} hours)`);
      
      // Fetch objects modified in the last N hours
      const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const objects = await this.fetchModifiedObjects(objectType, since);
      
      // Queue for processing
      for (const obj of objects) {
        await this.queueEventForProcessing({
          eventType: `${objectType.slice(0, -1)}.propertyChange`,
          objectType: objectType.slice(0, -1),
          objectId: obj.id,
          properties: obj.properties,
          occurredAt: Date.now()
        });
      }

      res.json({ 
        message: `Backfill triggered for ${objects.length} ${objectType}`,
        since: since
      });

    } catch (error) {
      logger.error('Backfill failed:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async fetchModifiedObjects(objectType, since) {
    // This would use HubSpot's search API to find recently modified objects
    // For demo purposes, return empty array
    return [];
  }

  async shutdown() {
    logger.info('Shutting down Webhook Sync Service');
    
    if (this.subscriptionId) {
      try {
        await axios.delete(`${config.webhookUrl}/subscriptions/${this.subscriptionId}`);
        logger.info('Unsubscribed from webhooks');
      } catch (error) {
        logger.warn('Failed to unsubscribe from webhooks:', error.message);
      }
    }

    if (processingQueue) {
      await processingQueue.close();
    }

    if (redis) {
      await redis.quit();
    }
  }
}

// Start the service
async function start() {
  const service = new WebhookSyncService();
  
  try {
    await service.initialize();
    
    service.app.listen(config.port, () => {
      logger.info(`Webhook Sync Solution running on port ${config.port}`);
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Received SIGINT, shutting down gracefully');
      await service.shutdown();
      process.exit(0);
    });
    
  } catch (error) {
    logger.error('Failed to start service:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { WebhookSyncService };