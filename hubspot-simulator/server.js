const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const client = require('prom-client');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Prometheus metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const apiRequestsTotal = new client.Counter({
  name: 'hubspot_api_requests_total',
  help: 'Total number of API requests',
  labelNames: ['method', 'endpoint', 'status_code'],
  registers: [register]
});

const rateLimitHits = new client.Counter({
  name: 'hubspot_rate_limit_hits_total',
  help: 'Total number of rate limit hits',
  labelNames: ['limit_type'],
  registers: [register]
});

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting configuration matching real HubSpot limits
const generalRateLimit = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: 100, // 100 requests per 10 seconds
  message: {
    status: 'error',
    message: 'Rate limit exceeded: 100 requests per 10 seconds',
    category: 'RATE_LIMITS'
  },
  standardHeaders: true,
  legacyHeaders: false,
  onLimitReached: () => {
    rateLimitHits.inc({ limit_type: 'general' });
  }
});

const searchRateLimit = rateLimit({
  windowMs: 1000, // 1 second
  max: 4, // 4 requests per second for search endpoints
  message: {
    status: 'error',
    message: 'Search API rate limit exceeded: 4 requests per second',
    category: 'RATE_LIMITS'
  },
  standardHeaders: true,
  legacyHeaders: false,
  onLimitReached: () => {
    rateLimitHits.inc({ limit_type: 'search' });
  }
});

// Daily rate limit simulation (simplified - in reality would use Redis/DB)
let dailyRequestCount = 0;
const DAILY_LIMIT = 250000;

const dailyRateLimit = (req, res, next) => {
  dailyRequestCount++;
  if (dailyRequestCount > DAILY_LIMIT) {
    rateLimitHits.inc({ limit_type: 'daily' });
    return res.status(429).json({
      status: 'error',
      message: 'Daily rate limit exceeded: 250,000 requests per day',
      category: 'RATE_LIMITS'
    });
  }
  next();
};

// Metrics middleware
const metricsMiddleware = (req, res, next) => {
  const originalSend = res.send;
  res.send = function(data) {
    apiRequestsTotal.inc({
      method: req.method,
      endpoint: req.path,
      status_code: res.statusCode
    });
    originalSend.call(this, data);
  };
  next();
};

app.use(metricsMiddleware);
app.use(dailyRateLimit);

// In-memory data store (in production, this would be a database)
let companies = [];
let contacts = [];
let deals = [];

// Load test data on startup
async function loadTestData() {
  try {
    const dataPath = path.join('/app/data', 'companies.json');
    const data = await fs.readFile(dataPath, 'utf8');
    companies = JSON.parse(data);
    console.log(`Loaded ${companies.length} companies`);
  } catch (error) {
    console.log('No existing test data found, starting with empty dataset');
    generateSampleData();
  }
}

// Generate sample data if none exists
function generateSampleData() {
  console.log('Generating sample companies...');
  for (let i = 0; i < 1000; i++) {
    companies.push({
      id: uuidv4(),
      properties: {
        name: `Company ${i + 1}`,
        domain: `company${i + 1}.com`,
        industry: ['Technology', 'Healthcare', 'Finance', 'Manufacturing'][i % 4],
        founded_year: 2000 + (i % 24),
        hs_lastmodifieddate: new Date(Date.now() - Math.random() * 86400000 * 365).toISOString(),
        hs_object_id: i + 1
      },
      createdAt: new Date(Date.now() - Math.random() * 86400000 * 365).toISOString(),
      updatedAt: new Date(Date.now() - Math.random() * 86400000 * 30).toISOString()
    });
  }
}

// Webhook notification helper
async function sendWebhookNotification(eventType, objectType, objectId, properties) {
  if (!process.env.WEBHOOK_URL) return;
  
  try {
    await axios.post(process.env.WEBHOOK_URL, {
      eventId: uuidv4(),
      subscriptionId: 'mock-subscription',
      portalId: 12345,
      appId: 67890,
      occurredAt: Date.now(),
      eventType,
      objectId,
      propertyName: null,
      propertyValue: null,
      changeSource: 'CRM',
      objectType: objectType.toUpperCase(),
      properties
    }, { timeout: 5000 });
  } catch (error) {
    console.log('Webhook notification failed:', error.message);
  }
}

// Companies API endpoints
app.get('/crm/v3/objects/companies', generalRateLimit, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 100);
  const after = req.query.after || '';
  const properties = req.query.properties ? req.query.properties.split(',') : ['name', 'domain'];
  
  let startIndex = 0;
  if (after) {
    startIndex = companies.findIndex(c => c.id === after) + 1;
  }
  
  const results = companies.slice(startIndex, startIndex + limit).map(company => ({
    id: company.id,
    properties: properties.reduce((acc, prop) => {
      if (company.properties[prop] !== undefined) {
        acc[prop] = company.properties[prop];
      }
      return acc;
    }, {}),
    createdAt: company.createdAt,
    updatedAt: company.updatedAt
  }));
  
  const paging = {
    next: startIndex + limit < companies.length ? {
      after: results[results.length - 1]?.id,
      link: `/crm/v3/objects/companies?limit=${limit}&after=${results[results.length - 1]?.id}`
    } : undefined
  };
  
  // Simulate API delay
  setTimeout(() => {
    res.json({ results, paging });
  }, Math.random() * 100 + 50); // 50-150ms delay
});

// Search API endpoint (with stricter rate limiting)
app.post('/crm/v3/objects/companies/search', searchRateLimit, (req, res) => {
  const { limit = 10, after = '', sorts = [], query = '', filterGroups = [] } = req.body;
  const maxLimit = Math.min(limit, 100);
  
  let filteredCompanies = [...companies];
  
  // Apply filters (simplified implementation)
  if (query) {
    filteredCompanies = filteredCompanies.filter(c => 
      c.properties.name?.toLowerCase().includes(query.toLowerCase()) ||
      c.properties.domain?.toLowerCase().includes(query.toLowerCase())
    );
  }
  
  // Apply sorting
  if (sorts.length > 0) {
    const sort = sorts[0];
    filteredCompanies.sort((a, b) => {
      const aVal = a.properties[sort.propertyName] || '';
      const bVal = b.properties[sort.propertyName] || '';
      return sort.direction === 'DESCENDING' ? bVal.localeCompare(aVal) : aVal.localeCompare(bVal);
    });
  }
  
  let startIndex = 0;
  if (after) {
    startIndex = filteredCompanies.findIndex(c => c.id === after) + 1;
  }
  
  const results = filteredCompanies.slice(startIndex, startIndex + maxLimit);
  const total = filteredCompanies.length;
  
  // Simulate longer delay for search
  setTimeout(() => {
    res.json({
      total,
      results,
      paging: startIndex + maxLimit < total ? {
        next: { after: results[results.length - 1]?.id }
      } : undefined
    });
  }, Math.random() * 200 + 100); // 100-300ms delay
});

// Get single company
app.get('/crm/v3/objects/companies/:companyId', generalRateLimit, (req, res) => {
  const company = companies.find(c => c.id === req.params.companyId);
  if (!company) {
    return res.status(404).json({
      status: 'error',
      message: 'Company not found',
      category: 'OBJECT_NOT_FOUND'
    });
  }
  
  res.json(company);
});

// Update company (triggers webhook)
app.patch('/crm/v3/objects/companies/:companyId', generalRateLimit, async (req, res) => {
  const company = companies.find(c => c.id === req.params.companyId);
  if (!company) {
    return res.status(404).json({
      status: 'error',
      message: 'Company not found',
      category: 'OBJECT_NOT_FOUND'
    });
  }
  
  // Update properties
  Object.assign(company.properties, req.body.properties);
  company.updatedAt = new Date().toISOString();
  company.properties.hs_lastmodifieddate = company.updatedAt;
  
  // Send webhook notification
  await sendWebhookNotification('company.propertyChange', 'company', company.id, company.properties);
  
  res.json(company);
});

// Create company (triggers webhook)
app.post('/crm/v3/objects/companies', generalRateLimit, async (req, res) => {
  const newCompany = {
    id: uuidv4(),
    properties: {
      ...req.body.properties,
      hs_object_id: companies.length + 1,
      hs_lastmodifieddate: new Date().toISOString()
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  companies.push(newCompany);
  
  // Send webhook notification
  await sendWebhookNotification('company.creation', 'company', newCompany.id, newCompany.properties);
  
  res.status(201).json(newCompany);
});

// Batch update endpoint for testing bursts
app.post('/crm/v3/objects/companies/batch/update', generalRateLimit, async (req, res) => {
  const { inputs } = req.body;
  const results = [];
  
  for (const input of inputs.slice(0, 100)) { // Limit batch size
    const company = companies.find(c => c.id === input.id);
    if (company) {
      Object.assign(company.properties, input.properties);
      company.updatedAt = new Date().toISOString();
      company.properties.hs_lastmodifieddate = company.updatedAt;
      results.push(company);
      
      // Send webhook for each update
      await sendWebhookNotification('company.propertyChange', 'company', company.id, company.properties);
    }
  }
  
  res.json({ results });
});

// Simulate API outages
app.get('/simulate/outage/:duration', (req, res) => {
  const duration = parseInt(req.params.duration) * 1000; // Convert to milliseconds
  const outageStart = Date.now();
  
  app.use('/crm/*', (req, res) => {
    if (Date.now() - outageStart < duration) {
      return res.status(503).json({
        status: 'error',
        message: 'Service temporarily unavailable',
        category: 'SERVICE_UNAVAILABLE'
      });
    }
  });
  
  setTimeout(() => {
    // Remove outage middleware after duration
    app._router.stack = app._router.stack.filter(layer => 
      !layer.regexp.test('/crm/')
    );
  }, duration);
  
  res.json({ message: `Simulating ${req.params.duration}s outage` });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    dailyRequestCount,
    dailyLimitRemaining: DAILY_LIMIT - dailyRequestCount
  });
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

// Reset daily counter at midnight (simplified)
setInterval(() => {
  dailyRequestCount = 0;
}, 24 * 60 * 60 * 1000);

// Start server
app.listen(port, async () => {
  console.log(`HubSpot Simulator running on port ${port}`);
  await loadTestData();
  console.log('✓ HubSpot API simulator ready');
});