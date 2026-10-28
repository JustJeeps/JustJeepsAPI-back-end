# MetalCloak Integration Guide

## Overview
MetalCloak uses **CAPTCHA protection** on their login page, making fully automated scraping impossible. This integration uses a **semi-automated approach** that requires manual login but automates all data extraction and processing.

## 🚫 Why Not Fully Automated?
- MetalCloak implements CAPTCHA on login
- No public API available
- Manual intervention required for authentication

## ✅ Semi-Automated Solution

### 1. Data Scraping (Manual Login Required)
```bash
npm run scrape-metalcloak
```

**Process:**
1. Opens Chrome browser to MetalCloak login page
2. **YOU MUST:** Enter credentials and solve CAPTCHA manually
3. Press ENTER in terminal when logged in
4. Script automatically scrapes all product data
5. Generates CSV and JSON files with pricing data

### 2. Database Integration (Fully Automated)
```bash
npm run process-metalcloak
```

**Process:**
1. Finds latest scraped data file
2. Matches products with existing SKUs
3. Updates database with MetalCloak pricing
4. Saves unmatched products for manual review

## 📁 File Structure
```
prisma/seeds/scrapping/metalCloak/
├── metalCloak-improved-scraper.js     # Semi-automated scraper
├── metalCloak-scrapping.js            # Your original scraper
└── output/                            # Generated data files
    ├── metalcloak-pricing-YYYY-MM-DD.csv
    ├── metalcloak-data-YYYY-MM-DD.json
    └── metalcloak-summary-YYYY-MM-DD.txt

services/metalcloak/
├── index.js                           # Database integration service
└── unmatched/
    └── metalcloak-unmatched.json      # Products needing manual SKU mapping

prisma/seeds/
└── metalcloak-integration.js          # Integration runner script
```

## 🔄 Recommended Workflow

### Initial Setup
1. Run scraper to get product catalog
2. Review unmatched products for SKU mapping
3. Create manual mappings if needed
4. Process data into database

### Regular Updates (Weekly/Bi-weekly)
1. `npm run scrape-metalcloak` (manual login required)
2. `npm run process-metalcloak` (fully automated)
3. Review unmatched products for new items

## 📊 Data Structure

### Scraped Data Fields
- `title` - Product name
- `productCode` - MetalCloak's product code
- `category` - Product category (Jeep JL, JK, etc.)
- `mapPrice` - MAP price string
- `mapPriceNumeric` - MAP price as number
- `yourPrice` - Dealer price string  
- `yourPriceNumeric` - Dealer price as number
- `productUrl` - Direct product link
- `scrapedAt` - Timestamp

### Database Integration
- Updates `VendorProduct` table with MetalCloak pricing
- Vendor ID: 17 (MetalCloak)
- Cost field: Uses `yourPriceNumeric` (dealer price)
- Inventory: Set to "In Stock" (MetalCloak doesn't provide quantities)

## 🎯 Product Matching Strategy

### Automatic Matching
1. **Exact SKU Match** - If MetalCloak code matches your SKU
2. **Title Matching** - Fuzzy matching on product names
3. **Description Matching** - Fallback text matching

### Manual Mapping Required
- Unmatched products saved to `unmatched/metalcloak-unmatched.json`
- Review and create SKU mappings as needed
- Consider adding MetalCloak codes to your `vendors_prefix.js` system

## 🚀 Usage Examples

### Run Complete Update Process
```bash
# Step 1: Scrape latest data (manual login required)
npm run scrape-metalcloak

# Step 2: Process into database (automated)
npm run process-metalcloak
```

### Check Integration Results
The process will show:
- Total products processed
- Successful matches and updates
- Unmatched products requiring review
- Updated statistics for MetalCloak pricing

## ⚠️ Important Notes

### Rate Limiting
- Script includes 2-second delays between categories
- Be respectful of MetalCloak's server resources

### Data Quality
- Review CSV files before processing
- Check unmatched products for new SKU mappings
- Verify pricing data accuracy

### Security
- Never commit login credentials to code
- Use this script manually when needed
- Consider VPN if accessing from office networks

## 🔧 Troubleshooting

### Login Issues
- Ensure correct credentials
- Complete CAPTCHA fully
- Wait for dashboard to load before pressing ENTER

### Scraping Errors
- Check internet connection
- Verify MetalCloak website structure hasn't changed
- Review error logs in output files

### Database Integration Issues
- Check unmatched products file
- Verify vendor_id (17) exists in vendors table
- Review Prisma connection

## 📈 Future Improvements

### Potential Enhancements
1. **Browser Automation with Session Saving** - Save login session for reuse
2. **Advanced SKU Matching** - Machine learning for better product matching  
3. **Incremental Updates** - Only process changed products
4. **Price Change Alerts** - Notify on significant price changes

### API Alternative
If MetalCloak ever provides an API:
1. Replace scraper with API service
2. Keep same database integration logic
3. Enable full automation

## 📞 Support
For issues with MetalCloak integration:
1. Check scraper output files for errors
2. Review unmatched products file
3. Verify database connection and vendor setup
4. Consider reaching out to MetalCloak for API access