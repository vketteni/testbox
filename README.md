# HubSpot to Databox Integration Benchmark

A comprehensive testing environment to compare different integration approaches with measurable performance metrics.

## Quick Start

```bash
# Setup environment
npm run setup

# Start infrastructure services
npm run start:infrastructure

# Generate test data (100K records)
npm run generate:data

# Run individual solution tests
npm run test:direct-polling
npm run test:webhook-sync
npm run test:hybrid-cdc

# Run comprehensive benchmark
npm run benchmark:run

# Generate comparison report
npm run benchmark:report
```

## Architecture

- **Mock HubSpot API**: Simulates real HubSpot with rate limiting
- **Mock Databox API**: Receives and validates data
- **Webhook Service**: Event notification system
- **4 Solution Types**: Direct polling, webhooks, hybrid CDC, native
- **Monitoring Stack**: Prometheus + Grafana dashboards
- **Benchmarking Tools**: Automated testing and reporting

## Test Scenarios

1. **Bulk Initial Sync**: 100K records
2. **Real-time Updates**: 1K updates/hour
3. **High-Frequency Bursts**: 5K updates/10min
4. **API Outage Recovery**: 30min downtime simulation
5. **Scale Stress Test**: 1M records

## Monitoring

- **Grafana Dashboard**: http://localhost:3000 (admin/admin)
- **Prometheus Metrics**: http://localhost:9090
- **API Endpoints**: 
  - HubSpot: http://localhost:3001
  - Databox: http://localhost:3003
  - Webhooks: http://localhost:3002

## Key Metrics Tracked

- API call volume (requests/hour)
- Data synchronization latency
- Record processing throughput
- Error rates and recovery times
- Resource utilization (CPU/Memory)
- Cost projections

## Cleanup

```bash
npm run clean
```