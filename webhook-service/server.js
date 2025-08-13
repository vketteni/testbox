const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');
const client = require('prom-client');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Prometheus metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const webhookEventsTotal = new client.Counter({
  name: 'webhook_events_total',
  help: 'Total number of webhook events received',
  labelNames: ['event_type', 'object_type'],
  registers: [register]
});

const webhookProcessingDuration = new client.Histogram({
  name: 'webhook_processing_duration_seconds',
  help: 'Duration of webhook processing',
  labelNames: ['event_type'],
  registers: [register]
});

const subscribersGauge = new client.Gauge({
  name: 'webhook_subscribers_total',
  help: 'Total number of active webhook subscribers',
  registers: [register]
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Redis connection
let redisClient;
async function initRedis() {
  redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  });
  
  redisClient.on('error', (err) => console.log('Redis Client Error', err));
  redisClient.on('connect', () => console.log('✓ Connected to Redis'));
  
  await redisClient.connect();
}

// In-memory subscribers store (in production, use Redis/DB for persistence)
const subscribers = new Map();

// Webhook subscription management
app.post('/subscriptions', async (req, res) => {
  const { url, events, secret } = req.body;
  
  if (!url || !events || !Array.isArray(events)) {
    return res.status(400).json({
      error: 'Missing required fields: url, events (array)'
    });
  }
  
  const subscriptionId = crypto.randomUUID();
  const subscription = {
    id: subscriptionId,
    url,
    events,
    secret,
    active: true,
    createdAt: new Date().toISOString(),
    lastNotified: null,
    successCount: 0,
    errorCount: 0
  };
  
  subscribers.set(subscriptionId, subscription);
  subscribersGauge.set(subscribers.size);
  
  // Store in Redis for persistence
  if (redisClient) {
    await redisClient.hSet('webhook:subscriptions', subscriptionId, JSON.stringify(subscription));
  }
  
  res.status(201).json({
    subscriptionId,
    message: 'Webhook subscription created successfully'
  });
});

// List subscriptions
app.get('/subscriptions', async (req, res) => {
  const subscriptionList = Array.from(subscribers.values());
  res.json({ subscriptions: subscriptionList });
});

// Delete subscription
app.delete('/subscriptions/:id', async (req, res) => {
  const { id } = req.params;
  
  if (subscribers.has(id)) {
    subscribers.delete(id);
    subscribersGauge.set(subscribers.size);
    
    if (redisClient) {
      await redisClient.hDel('webhook:subscriptions', id);
    }
    
    res.json({ message: 'Subscription deleted' });
  } else {
    res.status(404).json({ error: 'Subscription not found' });
  }
});

// Main webhook endpoint (receives notifications from HubSpot simulator)
app.post('/webhook', async (req, res) => {
  const startTime = Date.now();
  const event = req.body;
  
  console.log(`Received webhook: ${event.eventType} for ${event.objectType} ${event.objectId}`);
  
  // Validate webhook structure
  if (!event.eventType || !event.objectType || !event.objectId) {
    return res.status(400).json({
      error: 'Invalid webhook payload'
    });
  }
  
  // Record metrics
  webhookEventsTotal.inc({
    event_type: event.eventType,
    object_type: event.objectType
  });
  
  // Store event in Redis for processing
  if (redisClient) {
    const eventKey = `webhook:events:${Date.now()}:${crypto.randomUUID()}`;
    await redisClient.set(eventKey, JSON.stringify(event), { EX: 86400 }); // 24h expiry
    
    // Add to processing queue
    await redisClient.lPush('webhook:processing_queue', eventKey);
  }
  
  // Notify all relevant subscribers
  const notifications = [];
  for (const [subscriptionId, subscription] of subscribers.entries()) {
    if (!subscription.active) continue;
    
    // Check if subscriber is interested in this event type
    const eventMatch = subscription.events.some(subscribedEvent => {
      return subscribedEvent === '*' || 
             subscribedEvent === event.eventType ||
             subscribedEvent.startsWith(event.objectType.toLowerCase());
    });
    
    if (eventMatch) {
      notifications.push(notifySubscriber(subscription, event));
    }
  }
  
  // Wait for all notifications to complete
  const results = await Promise.allSettled(notifications);
  
  // Update processing duration metric
  const duration = (Date.now() - startTime) / 1000;
  webhookProcessingDuration.observe({ event_type: event.eventType }, duration);
  
  // Send response
  res.json({
    message: 'Webhook processed',
    eventId: event.eventId,
    notificationsSent: results.filter(r => r.status === 'fulfilled').length,
    notificationsFailed: results.filter(r => r.status === 'rejected').length
  });
});

// Notify individual subscriber
async function notifySubscriber(subscription, event) {
  const axios = require('axios');
  
  try {
    const payload = {
      subscriptionId: subscription.id,
      event: event,
      timestamp: Date.now()
    };
    
    // Create signature if secret is provided
    let headers = {
      'Content-Type': 'application/json',
      'X-HubSpot-Signature': 'v1=' + crypto.createHmac('sha256', subscription.secret || 'default')
        .update(JSON.stringify(payload))
        .digest('hex')
    };
    
    await axios.post(subscription.url, payload, {
      headers,
      timeout: 30000, // 30s timeout
      validateStatus: (status) => status < 500 // Don't throw on 4xx errors
    });
    
    // Update success count
    subscription.successCount++;
    subscription.lastNotified = new Date().toISOString();
    
    console.log(`✓ Notified subscriber ${subscription.id} at ${subscription.url}`);
    
  } catch (error) {
    // Update error count
    subscription.errorCount++;
    
    console.log(`✗ Failed to notify subscriber ${subscription.id}: ${error.message}`);
    
    // Deactivate subscription after too many failures
    if (subscription.errorCount > 10) {
      subscription.active = false;
      console.log(`⚠ Deactivated subscription ${subscription.id} due to repeated failures`);
    }
    
    throw error;
  }
}

// Event replay endpoint for testing
app.post('/replay/:eventId', async (req, res) => {
  if (!redisClient) {
    return res.status(503).json({ error: 'Redis not available' });
  }
  
  try {
    const eventKeys = await redisClient.keys(`webhook:events:*`);
    const events = await Promise.all(
      eventKeys.map(async key => {
        const eventData = await redisClient.get(key);
        return { key, event: JSON.parse(eventData) };
      })
    );
    
    const targetEvent = events.find(e => e.event.eventId === req.params.eventId);
    if (!targetEvent) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // Replay the event
    req.body = targetEvent.event;
    return app.post('/webhook')(req, res);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get webhook statistics
app.get('/stats', async (req, res) => {
  const stats = {
    totalSubscribers: subscribers.size,
    activeSubscribers: Array.from(subscribers.values()).filter(s => s.active).length,
    totalEvents: 0,
    eventsByType: {},
    subscriptionStats: Array.from(subscribers.values()).map(s => ({
      id: s.id,
      url: s.url,
      events: s.events,
      successCount: s.successCount,
      errorCount: s.errorCount,
      lastNotified: s.lastNotified,
      active: s.active
    }))
  };
  
  if (redisClient) {
    try {
      const eventKeys = await redisClient.keys('webhook:events:*');
      stats.totalEvents = eventKeys.length;
      
      // Get event type distribution
      const events = await Promise.all(
        eventKeys.slice(-100).map(async key => { // Last 100 events
          const eventData = await redisClient.get(key);
          return JSON.parse(eventData);
        })
      );
      
      events.forEach(event => {
        stats.eventsByType[event.eventType] = (stats.eventsByType[event.eventType] || 0) + 1;
      });
      
    } catch (error) {
      console.log('Error getting event stats:', error.message);
    }
  }
  
  res.json(stats);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    subscribers: subscribers.size,
    redis: redisClient?.isReady ? 'connected' : 'disconnected'
  });
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down webhook service...');
  if (redisClient) {
    await redisClient.quit();
  }
  process.exit(0);
});

// Start server
app.listen(port, async () => {
  console.log(`Webhook Service running on port ${port}`);
  await initRedis();
  
  // Load existing subscriptions from Redis
  if (redisClient) {
    try {
      const existingSubscriptions = await redisClient.hGetAll('webhook:subscriptions');
      for (const [id, data] of Object.entries(existingSubscriptions)) {
        subscribers.set(id, JSON.parse(data));
      }
      console.log(`✓ Loaded ${subscribers.size} existing subscriptions`);
      subscribersGauge.set(subscribers.size);
    } catch (error) {
      console.log('Could not load existing subscriptions:', error.message);
    }
  }
  
  console.log('✓ Webhook service ready');
});