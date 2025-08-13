const express = require('express');
const cors = require('cors');
const client = require('prom-client');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Prometheus metrics
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const metricsReceived = new client.Counter({
  name: 'databox_metrics_received_total',
  help: 'Total number of metrics received',
  labelNames: ['data_source', 'metric_name'],
  registers: [register]
});

const dataPushDuration = new client.Histogram({
  name: 'databox_data_push_duration_seconds',
  help: 'Duration of data push operations',
  labelNames: ['data_source'],
  registers: [register]
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// In-memory data store
const dataSources = new Map();
const metrics = new Map();
const rawData = [];

// Authentication middleware (simplified)
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.headers['x-api-token'];
  
  if (!token || token === 'undefined') {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please provide a valid API token'
    });
  }
  
  // In a real implementation, validate the token
  req.token = token;
  next();
};

// Create or get data source
function getOrCreateDataSource(name, token) {
  const key = `${token}:${name}`;
  if (!dataSources.has(key)) {
    dataSources.set(key, {
      id: uuidv4(),
      name,
      token,
      createdAt: new Date().toISOString(),
      lastUpdate: null,
      metricCount: 0,
      recordCount: 0
    });
  }
  return dataSources.get(key);
}

// Main data push endpoint (matches Databox API format)
app.post('/', authenticate, async (req, res) => {
  const startTime = Date.now();
  const { data = [], source = 'Default' } = req.body;
  
  if (!Array.isArray(data)) {
    return res.status(400).json({
      error: 'Invalid request',
      message: 'Data must be an array'
    });
  }
  
  const dataSource = getOrCreateDataSource(source, req.token);
  const processedMetrics = [];
  
  // Process each data point
  for (const item of data) {
    try {
      // Validate data format
      if (typeof item !== 'object' || item === null) {
        console.log('Skipping invalid data item:', item);
        continue;
      }
      
      // Extract metrics from the data item
      for (const [key, value] of Object.entries(item)) {
        if (key.startsWith('$')) {
          // This is a metric (Databox format uses $ prefix)
          const metricName = key.substring(1);
          const metricKey = `${dataSource.id}:${metricName}`;
          
          // Store metric definition
          if (!metrics.has(metricKey)) {
            metrics.set(metricKey, {
              id: uuidv4(),
              name: metricName,
              dataSource: dataSource.name,
              dataType: typeof value === 'number' ? 'numeric' : 'string',
              unit: item.unit || null,
              createdAt: new Date().toISOString(),
              lastValue: null,
              totalValues: 0
            });
          }
          
          const metric = metrics.get(metricKey);
          metric.lastValue = value;
          metric.totalValues++;
          metric.lastUpdate = new Date().toISOString();
          
          // Record the data point
          const dataPoint = {
            id: uuidv4(),
            dataSourceId: dataSource.id,
            metricId: metric.id,
            metricName,
            value,
            timestamp: item.date || new Date().toISOString(),
            attributes: { ...item },
            receivedAt: new Date().toISOString()
          };
          
          rawData.push(dataPoint);
          processedMetrics.push(dataPoint);
          
          // Update Prometheus metrics
          metricsReceived.inc({
            data_source: dataSource.name,
            metric_name: metricName
          });
        }
      }
      
      dataSource.recordCount++;
      
    } catch (error) {
      console.log('Error processing data item:', error.message, item);
    }
  }
  
  // Update data source
  dataSource.lastUpdate = new Date().toISOString();
  dataSource.metricCount = Array.from(metrics.keys()).filter(k => k.startsWith(dataSource.id)).length;
  
  // Save to file periodically
  if (rawData.length % 1000 === 0) {
    await saveDataToFile();
  }
  
  // Record processing duration
  const duration = (Date.now() - startTime) / 1000;
  dataPushDuration.observe({ data_source: dataSource.name }, duration);
  
  res.json({
    status: 'success',
    message: `Processed ${processedMetrics.length} metrics`,
    dataSource: dataSource.name,
    metricsProcessed: processedMetrics.length,
    timestamp: new Date().toISOString()
  });
});

// Alternative endpoint for batch data (similar to HubSpot format)
app.post('/batch', authenticate, async (req, res) => {
  const { records = [], dataSource = 'HubSpot' } = req.body;
  
  // Convert HubSpot-style records to Databox format
  const convertedData = records.map(record => {
    const converted = {};
    
    // Convert properties to metrics
    if (record.properties) {
      Object.entries(record.properties).forEach(([key, value]) => {
        if (typeof value === 'number' || (typeof value === 'string' && !isNaN(parseFloat(value)))) {
          converted[`$${key}`] = typeof value === 'number' ? value : parseFloat(value);
        }
      });
    }
    
    // Add metadata
    converted.date = record.updatedAt || record.createdAt || new Date().toISOString();
    converted.objectId = record.id;
    
    return converted;
  });
  
  // Process using the main endpoint logic
  req.body = { data: convertedData, source: dataSource };
  return app.post('/')(req, res);
});

// Get data sources
app.get('/datasources', authenticate, (req, res) => {
  const userDataSources = Array.from(dataSources.values())
    .filter(ds => ds.token === req.token);
  
  res.json({
    dataSources: userDataSources,
    total: userDataSources.length
  });
});

// Get metrics for a data source
app.get('/datasources/:name/metrics', authenticate, (req, res) => {
  const dataSource = Array.from(dataSources.values())
    .find(ds => ds.name === req.params.name && ds.token === req.token);
  
  if (!dataSource) {
    return res.status(404).json({ error: 'Data source not found' });
  }
  
  const sourceMetrics = Array.from(metrics.values())
    .filter(m => m.dataSource === dataSource.name);
  
  res.json({
    dataSource: dataSource.name,
    metrics: sourceMetrics,
    total: sourceMetrics.length
  });
});

// Get recent data points
app.get('/data/recent', authenticate, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const dataSource = req.query.dataSource;
  const metric = req.query.metric;
  
  let filteredData = rawData
    .filter(d => {
      const ds = dataSources.get(Object.keys(Object.fromEntries(dataSources)).find(k => k.endsWith(`:${dataSource}`) && dataSources.get(k).token === req.token));
      return !dataSource || (ds && d.dataSourceId === ds.id);
    })
    .filter(d => !metric || d.metricName === metric)
    .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))
    .slice(0, limit);
  
  res.json({
    data: filteredData,
    total: filteredData.length,
    filters: { dataSource, metric }
  });
});

// Statistics endpoint
app.get('/stats', authenticate, (req, res) => {
  const userDataSources = Array.from(dataSources.values())
    .filter(ds => ds.token === req.token);
  
  const userMetrics = Array.from(metrics.values())
    .filter(m => userDataSources.some(ds => ds.name === m.dataSource));
  
  const userDataPoints = rawData.filter(d => 
    userDataSources.some(ds => ds.id === d.dataSourceId)
  );
  
  const stats = {
    dataSources: userDataSources.length,
    metrics: userMetrics.length,
    dataPoints: userDataPoints.length,
    lastUpdate: userDataSources.reduce((latest, ds) => 
      !latest || (ds.lastUpdate && new Date(ds.lastUpdate) > new Date(latest)) 
        ? ds.lastUpdate 
        : latest
    , null),
    breakdown: {
      byDataSource: userDataSources.map(ds => ({
        name: ds.name,
        metrics: userMetrics.filter(m => m.dataSource === ds.name).length,
        dataPoints: userDataPoints.filter(d => d.dataSourceId === ds.id).length,
        lastUpdate: ds.lastUpdate
      })),
      byMetric: userMetrics.slice(0, 10).map(m => ({
        name: m.name,
        dataSource: m.dataSource,
        totalValues: m.totalValues,
        lastValue: m.lastValue,
        lastUpdate: m.lastUpdate
      }))
    }
  };
  
  res.json(stats);
});

// Save data to file
async function saveDataToFile() {
  try {
    const dataToSave = {
      dataSources: Object.fromEntries(dataSources),
      metrics: Object.fromEntries(metrics),
      dataPoints: rawData.slice(-10000) // Keep last 10K points
    };
    
    await fs.writeFile(
      path.join('/app/data', 'databox-data.json'),
      JSON.stringify(dataToSave, null, 2)
    );
  } catch (error) {
    console.log('Error saving data:', error.message);
  }
}

// Load data on startup
async function loadDataFromFile() {
  try {
    const dataPath = path.join('/app/data', 'databox-data.json');
    const data = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    
    // Restore data structures
    for (const [key, value] of Object.entries(data.dataSources || {})) {
      dataSources.set(key, value);
    }
    
    for (const [key, value] of Object.entries(data.metrics || {})) {
      metrics.set(key, value);
    }
    
    rawData.push(...(data.dataPoints || []));
    
    console.log(`✓ Loaded ${dataSources.size} data sources, ${metrics.size} metrics, ${rawData.length} data points`);
  } catch (error) {
    console.log('No existing data found, starting fresh');
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    dataSources: dataSources.size,
    metrics: metrics.size,
    dataPoints: rawData.length
  });
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.send(await register.metrics());
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Saving data before shutdown...');
  await saveDataToFile();
  process.exit(0);
});

// Periodic data saving
setInterval(saveDataToFile, 60000); // Save every minute

// Start server
app.listen(port, async () => {
  console.log(`Databox Simulator running on port ${port}`);
  await loadDataFromFile();
  console.log('✓ Databox API simulator ready');
});