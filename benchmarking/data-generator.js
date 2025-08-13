const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

// Configuration
const CONFIG = {
  TOTAL_COMPANIES: process.env.TOTAL_RECORDS || 100000,
  BATCH_SIZE: 1000, // Generate in batches to avoid memory issues
  OUTPUT_DIR: process.env.OUTPUT_DIR || '/app/data',
  HUBSPOT_URL: process.env.HUBSPOT_API_URL || 'http://localhost:3001',
  INDUSTRIES: [
    'Technology', 'Healthcare', 'Financial Services', 'Manufacturing',
    'Retail', 'Education', 'Real Estate', 'Construction', 'Transportation',
    'Energy', 'Media', 'Hospitality', 'Agriculture', 'Consulting',
    'Non-Profit', 'Government', 'Legal', 'Marketing', 'Design'
  ],
  COMPANY_SIZES: [
    { range: '1-10', weight: 30 },
    { range: '11-50', weight: 25 },
    { range: '51-200', weight: 20 },
    { range: '201-500', weight: 15 },
    { range: '501-1000', weight: 7 },
    { range: '1001-5000', weight: 2 },
    { range: '5000+', weight: 1 }
  ]
};

// Realistic company name generators
const COMPANY_PREFIXES = [
  'Global', 'Advanced', 'Premier', 'Elite', 'Strategic', 'Digital', 'Smart',
  'Innovative', 'Dynamic', 'Progressive', 'Integrated', 'Unified', 'NextGen'
];

const COMPANY_ROOTS = [
  'Solutions', 'Systems', 'Technologies', 'Dynamics', 'Ventures', 'Industries',
  'Enterprises', 'Group', 'Partners', 'Associates', 'Corporation', 'Holdings',
  'Innovations', 'Networks', 'Services', 'Labs', 'Works', 'Studio'
];

const DOMAINS_TLDS = ['.com', '.net', '.org', '.co', '.io', '.ai', '.tech'];

// Generate realistic company data
function generateCompany(index) {
  const id = uuidv4();
  const companyNumber = index + 1;
  
  // Generate company name
  const usePrefix = Math.random() < 0.3;
  const prefix = usePrefix ? COMPANY_PREFIXES[Math.floor(Math.random() * COMPANY_PREFIXES.length)] + ' ' : '';
  const root = COMPANY_ROOTS[Math.floor(Math.random() * COMPANY_ROOTS.length)];
  const name = `${prefix}${root} ${companyNumber}`;
  
  // Generate domain
  const domainBase = name.toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .substring(0, 20);
  const tld = DOMAINS_TLDS[Math.floor(Math.random() * DOMAINS_TLDS.length)];
  const domain = `${domainBase}${tld}`;
  
  // Generate dates
  const createdDaysAgo = Math.floor(Math.random() * 1825); // Up to 5 years ago
  const createdAt = new Date(Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000);
  const updatedDaysAgo = Math.floor(Math.random() * Math.min(createdDaysAgo, 30)); // Updated within last 30 days or since creation
  const updatedAt = new Date(Date.now() - updatedDaysAgo * 24 * 60 * 60 * 1000);
  
  // Select industry and company size
  const industry = CONFIG.INDUSTRIES[Math.floor(Math.random() * CONFIG.INDUSTRIES.length)];
  const companySizeRandom = Math.random() * 100;
  let cumulativeWeight = 0;
  let companySize = '1-10';
  
  for (const size of CONFIG.COMPANY_SIZES) {
    cumulativeWeight += size.weight;
    if (companySizeRandom <= cumulativeWeight) {
      companySize = size.range;
      break;
    }
  }
  
  // Generate revenue (correlated with company size)
  const sizeMultipliers = {
    '1-10': { min: 50000, max: 500000 },
    '11-50': { min: 500000, max: 2000000 },
    '51-200': { min: 2000000, max: 10000000 },
    '201-500': { min: 10000000, max: 50000000 },
    '501-1000': { min: 50000000, max: 200000000 },
    '1001-5000': { min: 200000000, max: 1000000000 },
    '5000+': { min: 1000000000, max: 10000000000 }
  };
  
  const revenueRange = sizeMultipliers[companySize];
  const annualRevenue = Math.floor(
    Math.random() * (revenueRange.max - revenueRange.min) + revenueRange.min
  );
  
  // Generate phone and address
  const phoneArea = Math.floor(Math.random() * 900) + 100;
  const phoneExchange = Math.floor(Math.random() * 900) + 100;
  const phoneNumber = Math.floor(Math.random() * 9000) + 1000;
  const phone = `+1-${phoneArea}-${phoneExchange}-${phoneNumber}`;
  
  const states = ['CA', 'NY', 'TX', 'FL', 'IL', 'PA', 'OH', 'GA', 'NC', 'MI'];
  const state = states[Math.floor(Math.random() * states.length)];
  const zip = Math.floor(Math.random() * 90000) + 10000;
  const address = `${Math.floor(Math.random() * 9999) + 1} Business Blvd`;
  const city = `City${Math.floor(Math.random() * 1000)}`;
  
  return {
    id,
    properties: {
      name,
      domain,
      industry,
      company_size: companySize,
      annual_revenue: annualRevenue,
      phone,
      address,
      city,
      state,
      zip: zip.toString(),
      founded_year: createdAt.getFullYear(),
      website: `https://${domain}`,
      description: `${industry} company specializing in innovative solutions`,
      createdate: createdAt.toISOString(),
      hs_lastmodifieddate: updatedAt.toISOString(),
      hs_object_id: companyNumber.toString()
    },
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    archived: false
  };
}

// Generate update patterns for realistic data changes
function generateUpdatePatterns(companies) {
  const updates = [];
  const now = Date.now();
  
  // Generate various update scenarios
  const updateScenarios = [
    { type: 'revenue_update', frequency: 0.1 }, // 10% of companies get revenue updates
    { type: 'contact_info', frequency: 0.05 }, // 5% get contact info updates
    { type: 'company_growth', frequency: 0.02 }, // 2% grow in size
    { type: 'regular_activity', frequency: 0.3 } // 30% have regular last modified updates
  ];
  
  companies.forEach((company, index) => {
    updateScenarios.forEach(scenario => {
      if (Math.random() < scenario.frequency) {
        const updateTime = new Date(now - Math.random() * 24 * 60 * 60 * 1000).toISOString();
        
        let updateData = {
          id: company.id,
          timestamp: updateTime,
          type: scenario.type
        };
        
        switch (scenario.type) {
          case 'revenue_update':
            updateData.properties = {
              annual_revenue: company.properties.annual_revenue * (0.8 + Math.random() * 0.4),
              hs_lastmodifieddate: updateTime
            };
            break;
            
          case 'contact_info':
            const phoneArea = Math.floor(Math.random() * 900) + 100;
            const phoneExchange = Math.floor(Math.random() * 900) + 100;
            const phoneNumber = Math.floor(Math.random() * 9000) + 1000;
            updateData.properties = {
              phone: `+1-${phoneArea}-${phoneExchange}-${phoneNumber}`,
              hs_lastmodifieddate: updateTime
            };
            break;
            
          case 'company_growth':
            const currentSizeIndex = CONFIG.COMPANY_SIZES.findIndex(s => s.range === company.properties.company_size);
            if (currentSizeIndex < CONFIG.COMPANY_SIZES.length - 1) {
              updateData.properties = {
                company_size: CONFIG.COMPANY_SIZES[currentSizeIndex + 1].range,
                hs_lastmodifieddate: updateTime
              };
            }
            break;
            
          case 'regular_activity':
            updateData.properties = {
              hs_lastmodifieddate: updateTime
            };
            break;
        }
        
        updates.push(updateData);
      }
    });
  });
  
  return updates.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// Main data generation function
async function generateTestData() {
  console.log(`🏭 Generating ${CONFIG.TOTAL_COMPANIES} test companies...`);
  
  const allCompanies = [];
  const startTime = Date.now();
  
  // Generate companies in batches
  for (let batch = 0; batch < Math.ceil(CONFIG.TOTAL_COMPANIES / CONFIG.BATCH_SIZE); batch++) {
    const batchStart = batch * CONFIG.BATCH_SIZE;
    const batchEnd = Math.min(batchStart + CONFIG.BATCH_SIZE, CONFIG.TOTAL_COMPANIES);
    const batchSize = batchEnd - batchStart;
    
    console.log(`  Batch ${batch + 1}: Generating companies ${batchStart + 1}-${batchEnd}...`);
    
    const batchCompanies = [];
    for (let i = batchStart; i < batchEnd; i++) {
      batchCompanies.push(generateCompany(i));
    }
    
    allCompanies.push(...batchCompanies);
    
    // Save batch to avoid memory issues
    await fs.writeFile(
      path.join(CONFIG.OUTPUT_DIR, `companies_batch_${batch + 1}.json`),
      JSON.stringify(batchCompanies, null, 2)
    );
    
    // Progress indicator
    const progress = ((batch + 1) / Math.ceil(CONFIG.TOTAL_COMPANIES / CONFIG.BATCH_SIZE)) * 100;
    console.log(`  Progress: ${progress.toFixed(1)}%`);
  }
  
  console.log(`\n📊 Generating update patterns...`);
  const updates = generateUpdatePatterns(allCompanies);
  
  // Save master files
  console.log(`💾 Saving master files...`);
  await fs.writeFile(
    path.join(CONFIG.OUTPUT_DIR, 'companies.json'),
    JSON.stringify(allCompanies, null, 2)
  );
  
  await fs.writeFile(
    path.join(CONFIG.OUTPUT_DIR, 'company_updates.json'),
    JSON.stringify(updates, null, 2)
  );
  
  // Generate statistics
  const stats = generateStatistics(allCompanies, updates);
  await fs.writeFile(
    path.join(CONFIG.OUTPUT_DIR, 'data_statistics.json'),
    JSON.stringify(stats, null, 2)
  );
  
  const duration = (Date.now() - startTime) / 1000;
  
  console.log(`\n✅ Data generation complete!`);
  console.log(`   Companies: ${allCompanies.length.toLocaleString()}`);
  console.log(`   Updates: ${updates.length.toLocaleString()}`);
  console.log(`   Duration: ${duration.toFixed(1)}s`);
  console.log(`   Rate: ${(allCompanies.length / duration).toFixed(0)} companies/sec`);
  console.log(`\n📁 Files saved to: ${CONFIG.OUTPUT_DIR}`);
  
  return { companies: allCompanies, updates, stats };
}

// Generate statistics about the dataset
function generateStatistics(companies, updates) {
  const stats = {
    totalCompanies: companies.length,
    totalUpdates: updates.length,
    generatedAt: new Date().toISOString(),
    
    industryBreakdown: {},
    sizeBreakdown: {},
    revenueDistribution: {
      under1M: 0,
      '1M-10M': 0,
      '10M-100M': 0,
      '100M-1B': 0,
      over1B: 0
    },
    
    temporal: {
      companiesCreatedLastYear: 0,
      companiesUpdatedLast30Days: 0,
      averageCompanyAge: 0
    },
    
    updatePatterns: {
      byType: {},
      averageUpdatesPerCompany: updates.length / companies.length
    }
  };
  
  const now = new Date();
  const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  
  let totalAge = 0;
  
  companies.forEach(company => {
    // Industry breakdown
    const industry = company.properties.industry;
    stats.industryBreakdown[industry] = (stats.industryBreakdown[industry] || 0) + 1;
    
    // Size breakdown
    const size = company.properties.company_size;
    stats.sizeBreakdown[size] = (stats.sizeBreakdown[size] || 0) + 1;
    
    // Revenue distribution
    const revenue = company.properties.annual_revenue;
    if (revenue < 1000000) stats.revenueDistribution.under1M++;
    else if (revenue < 10000000) stats.revenueDistribution['1M-10M']++;
    else if (revenue < 100000000) stats.revenueDistribution['10M-100M']++;
    else if (revenue < 1000000000) stats.revenueDistribution['100M-1B']++;
    else stats.revenueDistribution.over1B++;
    
    // Temporal analysis
    const createdAt = new Date(company.createdAt);
    const updatedAt = new Date(company.updatedAt);
    
    if (createdAt > oneYearAgo) stats.temporal.companiesCreatedLastYear++;
    if (updatedAt > thirtyDaysAgo) stats.temporal.companiesUpdatedLast30Days++;
    
    totalAge += now.getTime() - createdAt.getTime();
  });
  
  stats.temporal.averageCompanyAge = Math.floor((totalAge / companies.length) / (24 * 60 * 60 * 1000));
  
  // Update pattern analysis
  updates.forEach(update => {
    stats.updatePatterns.byType[update.type] = (stats.updatePatterns.byType[update.type] || 0) + 1;
  });
  
  return stats;
}

// Load generated data into HubSpot mock API
async function loadDataIntoHubSpot() {
  console.log(`\n🔄 Loading data into HubSpot mock API...`);
  
  try {
    const companiesData = await fs.readFile(path.join(CONFIG.OUTPUT_DIR, 'companies.json'), 'utf8');
    const companies = JSON.parse(companiesData);
    
    // Send data to HubSpot mock in batches
    const loadBatchSize = 100;
    let loaded = 0;
    
    for (let i = 0; i < companies.length; i += loadBatchSize) {
      const batch = companies.slice(i, i + loadBatchSize);
      
      try {
        await axios.post(`${CONFIG.HUBSPOT_URL}/load-test-data`, { companies: batch }, {
          timeout: 30000
        });
        
        loaded += batch.length;
        if (loaded % 1000 === 0) {
          console.log(`  Loaded ${loaded.toLocaleString()} companies...`);
        }
      } catch (error) {
        console.log(`  Warning: Failed to load batch starting at ${i}: ${error.message}`);
      }
    }
    
    console.log(`✅ Loaded ${loaded.toLocaleString()} companies into HubSpot mock API`);
    
  } catch (error) {
    console.log(`❌ Failed to load data into HubSpot API: ${error.message}`);
    console.log(`   Data files are available in ${CONFIG.OUTPUT_DIR} for manual loading`);
  }
}

// Main execution
async function main() {
  console.log('🚀 Test Data Generator');
  console.log('='.repeat(50));
  
  try {
    // Ensure output directory exists
    await fs.mkdir(CONFIG.OUTPUT_DIR, { recursive: true });
    
    // Generate the data
    const result = await generateTestData();
    
    // Try to load data into HubSpot mock (optional)
    if (process.env.LOAD_INTO_HUBSPOT !== 'false') {
      await loadDataIntoHubSpot();
    }
    
    console.log('\n🎯 Ready for benchmarking!');
    console.log(`   Use the generated data files for testing different integration approaches`);
    console.log(`   Statistics available in: data_statistics.json`);
    
  } catch (error) {
    console.error('❌ Error generating test data:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  generateTestData,
  generateCompany,
  generateUpdatePatterns,
  CONFIG
};