# HubSpot-Databox Integration Testing Guide

This guide provides comprehensive end-to-end testing procedures for the HubSpot-Databox integration benchmarking environment.

## Table of Contents

- [Overview](#overview)
- [End-to-End Workflow](#end-to-end-workflow)
- [Environment Setup](#environment-setup)
- [Manual Testing Commands](#manual-testing-commands)
  - [Service Health Checks](#service-health-checks)
  - [HubSpot API Testing](#hubspot-api-testing)
  - [Webhook Service Testing](#webhook-service-testing)
  - [Databox API Testing](#databox-api-testing)
  - [Integration Solution Testing](#integration-solution-testing)
  - [Rate Limiting Testing](#rate-limiting-testing)
  - [API Outage Simulation](#api-outage-simulation)
  - [Monitoring & Validation](#monitoring--validation)
- [Testing Scenarios](#testing-scenarios)
- [Troubleshooting](#troubleshooting)

## Overview

This testing environment simulates real-world integration challenges between HubSpot CRM and Databox analytics platform. It includes:

- **Mock HubSpot API** with realistic rate limiting
- **Mock Databox API** for data ingestion
- **Webhook Service** for event-driven notifications
- **Two Integration Solutions** (Direct Polling vs Webhook Sync)
- **Monitoring Stack** (Prometheus + Grafana)
- **Benchmarking Tools** for performance comparison

## End-to-End Workflow

1. **Setup Environment** → Start Docker services
2. **Generate Test Data** → Create realistic dataset
3. **Start Services** → Launch API simulators
4. **Run Integration Solutions** → Test different approaches
5. **Monitor & Validate** → Analyze performance metrics

---

## Environment Setup

### Prerequisites
- Docker and Docker Compose
- At least 4GB available RAM
- Ports 3000-3003, 6379, 9090 available

### Quick Start
```bash
# Clone and navigate to project
cd /path/to/testbox

# Build all services
docker-compose build

# Start infrastructure services
docker-compose up -d hubspot-api webhook-server databox-api redis prometheus grafana

# Generate test data (100K companies)
docker-compose run --rm benchmark-runner npm run generate-data

# Or generate smaller dataset for testing
TOTAL_RECORDS=1000 docker-compose run --rm benchmark-runner npm run generate-data
```

### Service Ports
- **HubSpot API**: `http://localhost:3001`
- **Webhook Service**: `http://localhost:3002`  
- **Databox API**: `http://localhost:3003`
- **Grafana Dashboard**: `http://localhost:3000` (admin/admin)
- **Prometheus**: `http://localhost:9090`
- **Redis**: `localhost:6379`

---

## Manual Testing Commands

### Service Health Checks

Verify all services are running properly:

```bash
# Check HubSpot simulator
curl http://localhost:3001/health

# Expected response:
# {
#   "status": "healthy",
#   "timestamp": "2025-08-14T...",
#   "dailyRequestCount": 0,
#   "dailyLimitRemaining": 250000,
#   "totalCompanies": 1000
# }

# Check Databox simulator  
curl http://localhost:3003/health

# Check webhook service
curl http://localhost:3002/health

# Check Prometheus metrics endpoint
curl http://localhost:9090/api/v1/query?query=up
```

### HubSpot API Testing

#### Fetch Companies

**Get first 10 companies:**
```bash
curl "http://localhost:3001/crm/v3/objects/companies?limit=10"
```

**Get companies with pagination:**
```bash
# Use 'after' cursor from previous response
curl "http://localhost:3001/crm/v3/objects/companies?limit=5&after=CURSOR_ID"
```

**Get specific properties only:**
```bash
curl "http://localhost:3001/crm/v3/objects/companies?limit=5&properties=name,domain,industry,annual_revenue"
```

#### Search Companies

**Search by company name:**
```bash
curl -X POST http://localhost:3001/crm/v3/objects/companies/search \
  -H "Content-Type: application/json" \
  -d '{
    "limit": 10,
    "query": "Technology",
    "sorts": [
      {
        "propertyName": "name",
        "direction": "ASCENDING"
      }
    ]
  }'
```

#### Individual Company Operations

**Get single company:**
```bash
# Replace COMPANY_ID with actual ID from previous calls
curl "http://localhost:3001/crm/v3/objects/companies/COMPANY_ID"
```

**Update company (triggers webhook):**
```bash
curl -X PATCH http://localhost:3001/crm/v3/objects/companies/COMPANY_ID \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "annual_revenue": 2500000,
      "industry": "Updated Industry",
      "phone": "+1-555-123-4567"
    }
  }'
```

**Create new company:**
```bash
curl -X POST http://localhost:3001/crm/v3/objects/companies \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "name": "Test Company Manual",
      "domain": "testcompany.com",
      "industry": "Technology",
      "annual_revenue": 1000000
    }
  }'
```

#### Batch Operations

**Batch update multiple companies:**
```bash
curl -X POST http://localhost:3001/crm/v3/objects/companies/batch/update \
  -H "Content-Type: application/json" \
  -d '{
    "inputs": [
      {
        "id": "COMPANY_ID_1",
        "properties": {
          "annual_revenue": 1500000
        }
      },
      {
        "id": "COMPANY_ID_2", 
        "properties": {
          "annual_revenue": 2000000
        }
      }
    ]
  }'
```

### Webhook Service Testing

#### Subscription Management

**Create webhook subscription:**
```bash
curl -X POST http://localhost:3002/subscriptions \
  -H "Content-Type: application/json" \
  -d '{
    "url": "http://webhook-sync:3000/webhook",
    "events": ["company.propertyChange", "company.creation", "contact.*"],
    "secret": "my-webhook-secret-key"
  }'

# Save the returned subscriptionId for later use
```

**List all subscriptions:**
```bash
curl http://localhost:3002/subscriptions
```

**Delete subscription:**
```bash
# Replace SUBSCRIPTION_ID with actual ID
curl -X DELETE http://localhost:3002/subscriptions/SUBSCRIPTION_ID
```

#### Webhook Statistics

**Get webhook processing stats:**
```bash
curl http://localhost:3002/stats

# Expected response includes:
# - totalSubscribers
# - activeSubscribers  
# - totalEvents
# - eventsByType
# - subscriptionStats
```

### Databox API Testing

#### Data Push Operations

**Push single metric:**
```bash
curl -X POST http://localhost:3003/ \
  -H "Content-Type: application/json" \
  -H "x-api-token: test-token" \
  -d '{
    "data": [
      {
        "$sales": 150000,
        "$deals_closed": 12,
        "$revenue_growth": 15.5,
        "date": "2025-08-14T12:00:00Z",
        "company_name": "Test Company",
        "industry": "Technology"
      }
    ],
    "source": "Manual-Test"
  }'
```

**Push multiple metrics:**
```bash
curl -X POST http://localhost:3003/ \
  -H "Content-Type: application/json" \
  -H "x-api-token: test-token" \
  -d '{
    "data": [
      {
        "$monthly_revenue": 50000,
        "$active_customers": 150,
        "date": "2025-08-01T00:00:00Z",
        "region": "North America"
      },
      {
        "$monthly_revenue": 45000,
        "$active_customers": 140,
        "date": "2025-07-01T00:00:00Z", 
        "region": "North America"
      }
    ],
    "source": "Manual-Monthly-Report"
  }'
```

**Push HubSpot-formatted data (auto-conversion):**
```bash
curl -X POST http://localhost:3003/batch \
  -H "Content-Type: application/json" \
  -H "x-api-token: test-token" \
  -d '{
    "records": [
      {
        "id": "12345",
        "properties": {
          "annual_revenue": 1000000,
          "founded_year": 2020,
          "name": "Auto Conversion Test"
        },
        "updatedAt": "2025-08-14T12:00:00Z"
      }
    ],
    "dataSource": "HubSpot-Manual"
  }'
```

#### Data Retrieval

**Get data sources:**
```bash
curl -H "x-api-token: test-token" http://localhost:3003/datasources
```

**Get metrics for a data source:**
```bash
curl -H "x-api-token: test-token" http://localhost:3003/datasources/Manual-Test/metrics
```

**Get recent data points:**
```bash
# Get last 50 data points
curl -H "x-api-token: test-token" "http://localhost:3003/data/recent?limit=50"

# Filter by data source
curl -H "x-api-token: test-token" "http://localhost:3003/data/recent?limit=25&dataSource=Manual-Test"

# Filter by specific metric
curl -H "x-api-token: test-token" "http://localhost:3003/data/recent?limit=10&metric=sales"
```

**Get comprehensive stats:**
```bash
curl -H "x-api-token: test-token" http://localhost:3003/stats
```

#### Authentication Testing

**Test missing token (should fail):**
```bash
curl -X POST http://localhost:3003/ \
  -H "Content-Type: application/json" \
  -d '{"data": [{"$test": 100}]}'

# Expected: 401 Unauthorized
```

**Test invalid token:**
```bash
curl -X POST http://localhost:3003/ \
  -H "Content-Type: application/json" \
  -H "x-api-token: invalid-token" \
  -d '{"data": [{"$test": 100}]}'
```

### Integration Solution Testing

#### Direct Polling Solution

**Start the direct polling service:**
```bash
# Start in background
docker-compose --profile testing up -d direct-polling

# Check service status
curl http://localhost:3000/stats

# Expected response:
# {
#   "solution": "Direct Polling",
#   "isRunning": false,
#   "lastSyncStates": {...},
#   "config": {
#     "syncInterval": "*/5 * * * *",
#     "batchSize": 100
#   }
# }
```

**Trigger manual sync:**
```bash
curl -X POST http://localhost:3000/sync/trigger

# Monitor progress
curl http://localhost:3000/stats
curl http://localhost:3000/metrics
```

**Check logs:**
```bash
docker-compose logs -f direct-polling
```

#### Webhook Sync Solution

**Start webhook sync service:**
```bash
# Start in background
docker-compose --profile testing up -d webhook-sync

# Check status
curl http://localhost:3000/stats

# Expected response includes subscription info
```

**Trigger backfill for last 24 hours:**
```bash
curl -X POST http://localhost:3000/sync/backfill \
  -H "Content-Type: application/json" \
  -d '{
    "objectType": "companies",
    "hours": 24
  }'
```

**Manual initial sync:**
```bash
curl -X POST http://localhost:3000/sync/initial
```

**Monitor webhook processing:**
```bash
# Check processing stats
curl http://localhost:3000/stats

# Check logs
docker-compose logs -f webhook-sync
```

### Rate Limiting Testing

#### Test General Rate Limit (100 requests/10 seconds)

**Rapid-fire requests:**
```bash
# This should trigger rate limiting
echo "Testing general rate limit..."
for i in {1..110}; do
  response=$(curl -s -w "%{http_code}" -o /dev/null "http://localhost:3001/crm/v3/objects/companies?limit=1")
  echo "Request $i: HTTP $response"
  if [ "$response" = "429" ]; then
    echo "Rate limit hit at request $i"
    break
  fi
done
```

#### Test Search API Rate Limit (4 requests/second)

**Concurrent search requests:**
```bash
echo "Testing search API rate limit..."
for i in {1..10}; do
  curl -X POST http://localhost:3001/crm/v3/objects/companies/search \
    -H "Content-Type: application/json" \
    -d '{"limit": 5}' \
    -w "Request '$i': %{http_code}\n" \
    -o /dev/null \
    -s &
done
wait
```

#### Monitor Rate Limit Metrics

**Check rate limit hits:**
```bash
# Get rate limit metrics from Prometheus
curl "http://localhost:9090/api/v1/query?query=hubspot_rate_limit_hits_total"

# Check HubSpot health for current limits
curl http://localhost:3001/health
```

### API Outage Simulation

#### Simulate Service Outage

**Start 30-second outage:**
```bash
echo "Starting 30-second API outage..."
curl http://localhost:3001/simulate/outage/30

# Test during outage (should return 503)
echo "Testing during outage..."
curl -w "HTTP Status: %{http_code}\n" http://localhost:3001/crm/v3/objects/companies?limit=1

# Wait and test recovery
sleep 35
echo "Testing after outage recovery..."
curl -w "HTTP Status: %{http_code}\n" http://localhost:3001/crm/v3/objects/companies?limit=1
```

#### Test Integration Resilience During Outage

**Monitor solution behavior during outage:**
```bash
# Start integration solution
docker-compose --profile testing up -d direct-polling

# Trigger sync during outage
curl http://localhost:3001/simulate/outage/60
curl -X POST http://localhost:3000/sync/trigger

# Monitor error handling
docker-compose logs -f direct-polling
```

### Monitoring & Validation

#### Prometheus Metrics Queries

**HubSpot API metrics:**
```bash
# Total API requests
curl "http://localhost:9090/api/v1/query?query=hubspot_api_requests_total"

# Rate limit hits by type
curl "http://localhost:9090/api/v1/query?query=hubspot_rate_limit_hits_total"

# API request rate
curl "http://localhost:9090/api/v1/query?query=rate(hubspot_api_requests_total[5m])"
```

**Databox metrics:**
```bash
# Total metrics received
curl "http://localhost:9090/api/v1/query?query=databox_metrics_received_total"

# Data push duration
curl "http://localhost:9090/api/v1/query?query=databox_data_push_duration_seconds"

# Metrics by data source
curl "http://localhost:9090/api/v1/query?query=sum(databox_metrics_received_total)%20by%20(data_source)"
```

**Integration solution metrics:**
```bash
# Direct polling metrics
curl "http://localhost:9090/api/v1/query?query=direct_polling_sync_duration_seconds"
curl "http://localhost:9090/api/v1/query?query=direct_polling_records_processed_total"

# Webhook sync metrics  
curl "http://localhost:9090/api/v1/query?query=webhook_sync_events_received_total"
curl "http://localhost:9090/api/v1/query?query=webhook_sync_processing_duration_seconds"
```

#### Grafana Dashboard

Access the visual dashboard:
```bash
# Open in browser
open http://localhost:3000

# Login credentials: admin/admin
```

#### Schema Validation

**Run API format validation:**
```bash
docker-compose run --rm benchmark-runner node validation/schema-validator.js
```

**Expected validation output:**
```
🔬 API Mock Validation Report
==================================================

🔍 Validating HubSpot Mock API Format...
✅ HubSpot Mock Format: VALID

🔍 Validating Databox Mock API Format...  
✅ Databox Mock Format: VALID

🔍 Validating Rate Limiting Behavior...
✅ Rate limiting is working
✅ Search API rate limiting is working
```

---

## Testing Scenarios

### Scenario 1: Basic Data Flow Validation

**Objective**: Verify complete data pipeline from HubSpot → Databox

```bash
# 1. Generate minimal test dataset
TOTAL_RECORDS=100 docker-compose run --rm benchmark-runner npm run generate-data

# 2. Start webhook sync solution
docker-compose --profile testing up -d webhook-sync

# 3. Update a company (triggers webhook)
company_id=$(curl -s "http://localhost:3001/crm/v3/objects/companies?limit=1" | jq -r '.results[0].id')
curl -X PATCH "http://localhost:3001/crm/v3/objects/companies/$company_id" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"annual_revenue": 5000000}}'

# 4. Verify data reached Databox
sleep 5
curl -H "x-api-token: webhook-sync-token" "http://localhost:3003/data/recent?limit=10"

# 5. Check metrics
curl "http://localhost:9090/api/v1/query?query=webhook_sync_events_received_total"
```

### Scenario 2: Rate Limiting Resilience

**Objective**: Test integration behavior under API rate limits

```bash
# 1. Start direct polling with aggressive settings
SYNC_INTERVAL="*/1 * * * *" BATCH_SIZE=200 docker-compose --profile testing up -d direct-polling

# 2. Simultaneously hit API directly to consume rate limit
for i in {1..150}; do curl -s "http://localhost:3001/crm/v3/objects/companies?limit=1" > /dev/null & done

# 3. Trigger sync and observe handling
curl -X POST http://localhost:3000/sync/trigger

# 4. Monitor logs for retry behavior
docker-compose logs -f direct-polling
```

### Scenario 3: Webhook Event Processing

**Objective**: Validate real-time event handling and processing

```bash
# 1. Start webhook sync
docker-compose --profile testing up -d webhook-sync

# 2. Create multiple companies rapidly
for i in {1..20}; do
  curl -X POST http://localhost:3001/crm/v3/objects/companies \
    -H "Content-Type: application/json" \
    -d "{\"properties\": {\"name\": \"Bulk Test $i\", \"domain\": \"test$i.com\"}}" &
done
wait

# 3. Monitor webhook processing
curl http://localhost:3002/stats
curl http://localhost:3000/stats

# 4. Verify all data processed
curl -H "x-api-token: webhook-sync-token" "http://localhost:3003/stats"
```

### Scenario 4: Outage Recovery Testing

**Objective**: Test data consistency after service interruptions

```bash
# 1. Start integration solution
docker-compose --profile testing up -d direct-polling

# 2. Perform initial sync
curl -X POST http://localhost:3000/sync/trigger
sleep 10

# 3. Update companies during normal operation
for i in {1..10}; do
  company_id=$(curl -s "http://localhost:3001/crm/v3/objects/companies?limit=1&after=cursor$i" | jq -r '.results[0].id')
  curl -X PATCH "http://localhost:3001/crm/v3/objects/companies/$company_id" \
    -H "Content-Type: application/json" \
    -d "{\"properties\": {\"annual_revenue\": $((1000000 + i * 100000))}}"
done

# 4. Simulate 2-minute outage
curl http://localhost:3001/simulate/outage/120

# 5. Continue updating during outage
for i in {11..20}; do
  company_id=$(curl -s "http://localhost:3001/crm/v3/objects/companies?limit=1&after=cursor$i" | jq -r '.results[0].id')
  curl -X PATCH "http://localhost:3001/crm/v3/objects/companies/$company_id" \
    -H "Content-Type: application/json" \
    -d "{\"properties\": {\"annual_revenue\": $((1000000 + i * 100000))}}" || echo "Update $i failed (expected during outage)"
done

# 6. Wait for recovery and trigger sync
sleep 130
curl -X POST http://localhost:3000/sync/trigger

# 7. Verify data consistency
curl -H "x-api-token: direct-polling-token" "http://localhost:3003/stats"
```

### Scenario 5: Performance Benchmarking

**Objective**: Compare integration solution performance

```bash
# 1. Generate large dataset
TOTAL_RECORDS=10000 docker-compose run --rm benchmark-runner npm run generate-data

# 2. Test direct polling performance
echo "Testing Direct Polling..."
time docker-compose --profile testing run --rm direct-polling timeout 300 npm start

# 3. Test webhook sync performance  
echo "Testing Webhook Sync..."
time docker-compose --profile testing run --rm webhook-sync timeout 300 npm start

# 4. Run comprehensive benchmark
docker-compose --profile testing run --rm benchmark-runner npm run benchmark

# 5. Generate comparison report
docker-compose --profile testing run --rm benchmark-runner npm run generate-report
```

---

## Troubleshooting

### Common Issues

#### Services Won't Start
```bash
# Check port conflicts
netstat -tulpn | grep :300[0-3]

# Check Docker resources
docker system df
docker system prune -f

# Restart services
docker-compose down
docker-compose up -d
```

#### Rate Limiting Too Aggressive
```bash
# Reset HubSpot rate limit counters
curl http://localhost:3001/health  # Check current usage
docker-compose restart hubspot-api  # Reset counters
```

#### Webhook Events Not Firing
```bash
# Check webhook subscriptions
curl http://localhost:3002/subscriptions

# Check webhook service logs
docker-compose logs webhook-server

# Verify webhook URL accessibility
docker-compose exec webhook-sync curl http://webhook-server:3000/health
```

#### Data Not Appearing in Databox
```bash
# Check authentication
curl -H "x-api-token: wrong-token" http://localhost:3003/stats  # Should fail

# Check data format
curl -H "x-api-token: test-token" "http://localhost:3003/data/recent?limit=10"

# Verify metrics format (should use $ prefix)
# Correct: {"$revenue": 1000}
# Incorrect: {"revenue": 1000}
```

#### Prometheus Metrics Missing
```bash
# Check metric endpoints
curl http://localhost:3001/metrics  # HubSpot metrics
curl http://localhost:3003/metrics  # Databox metrics  
curl http://localhost:3000/metrics  # Solution metrics

# Restart Prometheus
docker-compose restart prometheus
```

### Debugging Commands

**View all service logs:**
```bash
docker-compose logs -f --tail=50
```

**Check service resource usage:**
```bash
docker stats
```

**Inspect Docker networks:**
```bash
docker network ls
docker network inspect testbox_benchmark-net
```

**Reset everything:**
```bash
docker-compose down -v
docker system prune -f
docker-compose build --no-cache
docker-compose up -d
```

### Performance Tuning

**For higher throughput testing:**
```bash
# Increase batch sizes
BATCH_SIZE=500 docker-compose --profile testing up direct-polling

# Reduce processing delays  
PROCESSING_DELAY=100 docker-compose --profile testing up webhook-sync

# Generate larger datasets
TOTAL_RECORDS=100000 docker-compose run --rm benchmark-runner npm run generate-data
```

**Memory optimization:**
```bash
# Monitor memory usage
docker stats --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}"

# Limit container memory if needed
docker-compose up -d --memory=2g
```

---

## Advanced Testing

### Load Testing Script

Create a load testing script:

```bash
#!/bin/bash
# load_test.sh

echo "Starting load test..."

# Function to create companies
create_companies() {
  for i in $(seq 1 100); do
    curl -s -X POST http://localhost:3001/crm/v3/objects/companies \
      -H "Content-Type: application/json" \
      -d "{\"properties\": {\"name\": \"Load Test $i\", \"domain\": \"loadtest$i.com\"}}" > /dev/null &
  done
  wait
}

# Function to update companies  
update_companies() {
  company_ids=$(curl -s "http://localhost:3001/crm/v3/objects/companies?limit=50" | jq -r '.results[].id')
  for id in $company_ids; do
    curl -s -X PATCH "http://localhost:3001/crm/v3/objects/companies/$id" \
      -H "Content-Type: application/json" \
      -d "{\"properties\": {\"annual_revenue\": $RANDOM}}" > /dev/null &
  done
  wait
}

# Run load test
echo "Creating companies..."
time create_companies

echo "Updating companies..."  
time update_companies

echo "Load test complete!"
```

### Custom Monitoring Queries

**Advanced Prometheus queries:**

```bash
# API request rate by endpoint
curl "http://localhost:9090/api/v1/query?query=sum(rate(hubspot_api_requests_total[5m]))%20by%20(endpoint)"

# Error rate percentage
curl "http://localhost:9090/api/v1/query?query=sum(rate(hubspot_api_requests_total{status_code=~'4..|5..'}[5m]))%20/%20sum(rate(hubspot_api_requests_total[5m]))%20*%20100"

# Sync lag analysis
curl "http://localhost:9090/api/v1/query?query=histogram_quantile(0.95,%20rate(direct_polling_sync_duration_seconds_bucket[5m]))"

# Webhook processing backlog
curl "http://localhost:9090/api/v1/query?query=webhook_sync_queue_size"
```

This comprehensive testing guide provides complete coverage of all system components and integration patterns, enabling thorough validation and performance analysis of the HubSpot-Databox integration benchmarking environment.