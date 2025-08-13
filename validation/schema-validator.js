const axios = require('axios');

// Expected HubSpot CRM API format based on documentation
const expectedHubSpotFormat = {
  results: [
    {
      id: "string", // Should be string ID like "8109465573"
      properties: {
        createdate: "ISO 8601 string", // Default property
        domain: "string", // Default property
        hs_lastmodifieddate: "ISO 8601 string", // Default property
        hs_object_id: "string", // Default property (same as id)
        name: "string", // Default property
        // Additional custom properties can be included
      },
      createdAt: "ISO 8601 string",
      updatedAt: "ISO 8601 string",
      archived: false // Should always be present
    }
  ],
  paging: {
    next: {
      after: "string", // Cursor for next page
      link: "string" // Optional: link to next page
    }
  }
};

// Expected Databox format based on documentation
const expectedDataboxFormat = {
  endpoint: "https://push.databox.com",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/vnd.databox.v2+json" // Optional but recommended
  },
  authentication: "Basic Auth with token",
  payload: {
    data: [
      {
        "$metric_name": "numeric_value", // $ prefix for metrics
        date: "ISO 8601 string", // Optional timestamp
        unit: "string", // Optional unit
        // Additional attributes for dimensions
      }
    ]
  },
  response: {
    success: "200 OK",
    message: "confirmation message"
  }
};

async function validateHubSpotMock() {
  console.log("🔍 Validating HubSpot Mock API Format...\n");
  
  try {
    const response = await axios.get('http://localhost:3001/crm/v3/objects/companies?limit=1');
    const mockData = response.data;
    
    console.log("Mock Response Structure:");
    console.log(JSON.stringify(mockData, null, 2));
    
    // Validation checks
    const issues = [];
    
    // Check top-level structure
    if (!mockData.results || !Array.isArray(mockData.results)) {
      issues.push("❌ Missing 'results' array");
    }
    
    if (!mockData.paging) {
      issues.push("❌ Missing 'paging' object");
    }
    
    // Check result item structure
    if (mockData.results && mockData.results.length > 0) {
      const item = mockData.results[0];
      
      if (!item.id || typeof item.id !== 'string') {
        issues.push("❌ Item 'id' should be string");
      }
      
      if (!item.properties || typeof item.properties !== 'object') {
        issues.push("❌ Missing 'properties' object");
      } else {
        // Check required default properties
        const requiredProps = ['name', 'domain'];
        const missingProps = requiredProps.filter(prop => !(prop in item.properties));
        if (missingProps.length > 0) {
          issues.push(`❌ Missing default properties: ${missingProps.join(', ')}`);
        }
        
        // Check for HubSpot-specific properties that should exist
        const hubspotProps = ['hs_object_id', 'hs_lastmodifieddate'];
        const missingHsProps = hubspotProps.filter(prop => !(prop in item.properties));
        if (missingHsProps.length > 0) {
          issues.push(`⚠️ Missing HubSpot properties: ${missingHsProps.join(', ')}`);
        }
      }
      
      if (!item.createdAt || !item.updatedAt) {
        issues.push("❌ Missing createdAt or updatedAt timestamps");
      }
      
      if (!('archived' in item)) {
        issues.push("⚠️ Missing 'archived' property (should default to false)");
      }
    }
    
    // Check paging structure
    if (mockData.paging && mockData.paging.next) {
      if (!mockData.paging.next.after) {
        issues.push("❌ Missing paging.next.after cursor");
      }
    }
    
    if (issues.length === 0) {
      console.log("\n✅ HubSpot Mock Format: VALID");
    } else {
      console.log("\n🔧 HubSpot Mock Issues Found:");
      issues.forEach(issue => console.log(`  ${issue}`));
    }
    
  } catch (error) {
    console.log("❌ Error validating HubSpot mock:", error.message);
  }
}

async function validateDataboxMock() {
  console.log("\n🔍 Validating Databox Mock API Format...\n");
  
  try {
    // Test data push format
    const testPayload = {
      data: [
        {
          "$sales": 123000,
          "$deals": 25,
          date: "2025-08-13T18:00:00Z"
        }
      ]
    };
    
    console.log("Test Payload:");
    console.log(JSON.stringify(testPayload, null, 2));
    
    const response = await axios.post('http://localhost:3003/', testPayload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': 'test-token'
      }
    });
    
    console.log("\nMock Response:");
    console.log(JSON.stringify(response.data, null, 2));
    
    const issues = [];
    const mockResponse = response.data;
    
    // Check response format
    if (!mockResponse.status) {
      issues.push("❌ Missing 'status' field in response");
    }
    
    if (mockResponse.status !== 'success') {
      issues.push("❌ Status should be 'success' for valid requests");
    }
    
    if (!mockResponse.message) {
      issues.push("❌ Missing confirmation message");
    }
    
    // Test metric name format (should accept $ prefix)
    const hasValidMetricFormat = Object.keys(testPayload.data[0]).some(key => key.startsWith('$'));
    if (!hasValidMetricFormat) {
      issues.push("❌ Metric names should use $ prefix format");
    }
    
    // Test authentication
    try {
      await axios.post('http://localhost:3003/', testPayload, {
        headers: { 'Content-Type': 'application/json' }
        // No token
      });
      issues.push("❌ Should require authentication token");
    } catch (authError) {
      if (authError.response?.status === 401) {
        console.log("✅ Authentication properly enforced");
      }
    }
    
    if (issues.length === 0) {
      console.log("\n✅ Databox Mock Format: VALID");
    } else {
      console.log("\n🔧 Databox Mock Issues Found:");
      issues.forEach(issue => console.log(`  ${issue}`));
    }
    
  } catch (error) {
    console.log("❌ Error validating Databox mock:", error.message);
  }
}

async function validateRateLimiting() {
  console.log("\n🔍 Validating Rate Limiting Behavior...\n");
  
  try {
    console.log("Testing general rate limit (100 requests/10 seconds)...");
    
    const requests = [];
    for (let i = 0; i < 105; i++) {
      requests.push(
        axios.get('http://localhost:3001/crm/v3/objects/companies?limit=1')
          .catch(err => ({ error: true, status: err.response?.status, data: err.response?.data }))
      );
    }
    
    const results = await Promise.all(requests);
    const rateLimitHits = results.filter(r => r.error && r.status === 429);
    
    console.log(`Made 105 requests, got ${rateLimitHits.length} rate limit responses`);
    
    if (rateLimitHits.length > 0) {
      console.log("✅ Rate limiting is working");
      console.log("Sample rate limit response:");
      console.log(JSON.stringify(rateLimitHits[0].data, null, 2));
    } else {
      console.log("⚠️ Rate limiting might not be working properly");
    }
    
    // Test search API rate limit (4 req/sec)
    console.log("\nTesting search API rate limit (4 requests/second)...");
    
    const searchRequests = [];
    for (let i = 0; i < 8; i++) {
      searchRequests.push(
        axios.post('http://localhost:3001/crm/v3/objects/companies/search', { limit: 10 })
          .catch(err => ({ error: true, status: err.response?.status, data: err.response?.data }))
      );
    }
    
    const searchResults = await Promise.all(searchRequests);
    const searchRateLimitHits = searchResults.filter(r => r.error && r.status === 429);
    
    console.log(`Made 8 search requests, got ${searchRateLimitHits.length} rate limit responses`);
    
    if (searchRateLimitHits.length > 0) {
      console.log("✅ Search API rate limiting is working");
    } else {
      console.log("⚠️ Search API rate limiting might not be strict enough");
    }
    
  } catch (error) {
    console.log("❌ Error testing rate limiting:", error.message);
  }
}

async function main() {
  console.log("🔬 API Mock Validation Report");
  console.log("=" * 50);
  
  await validateHubSpotMock();
  await validateDataboxMock();
  await validateRateLimiting();
  
  console.log("\n📋 Validation Summary:");
  console.log("- Check issues marked with ❌ for critical fixes");
  console.log("- Check warnings marked with ⚠️ for improvements");  
  console.log("- Items marked with ✅ are working correctly");
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  validateHubSpotMock,
  validateDataboxMock,
  validateRateLimiting
};