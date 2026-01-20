
// /PAGES INDIVIDUAL PRODUCTS

const puppeteer = require('puppeteer');
const fs = require('fs');
const { stringify } = require('csv-stringify/sync');

const BASE_URL = 'https://jobber.metalcloak.com';
const LOGIN_URL = `${BASE_URL}/customer/account/login`;
const CATEGORY_PATHS = [
  // "/ford-bronco-6g.html",
  // "/jeep-jt-gladiator-parts-accessories.html",
  // "/jeep-jl-wrangler-parts-accessories.html",
  // // "/jeep-jk-wrangler-parts-accessories.html",
  // "/jeep-tj-lj-wrangler-parts-accessories.html",
  // "/jeep-yj-wrangler-parts-accessories.html",
  // "/jeep-cj5-cj7-cj8-parts-accessories.html",
  // "/metalcloak-adventure-rack-systems.html",
  "/builder-parts.html",
  "/tools-accessories.html",
  "/rocksport-shocks.html",
  "/toyota-suspension-accessories.html",
  "/dodge-ram-suspension-lift-kits.html",
  "/new-metalcloak-products.html",
  "/carbon-axles.html",
  "/ineos-grenadier-products.html",
  "/shock-absorbers.html"
];



(async () => {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

  console.log('\n🔐 Please manually log in and solve CAPTCHA.');
  console.log('📌 Once you see the orange buttons (dashboard), press ENTER in this terminal...\n');
  await new Promise(resolve => process.stdin.once('data', resolve));

  const allData = [];

  for (const path of CATEGORY_PATHS) {
    const categoryUrl = `${BASE_URL}${path}`;
    console.log(`🔍 Scraping: ${categoryUrl}`);
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded' });

    const productLinks = await page.$$eval(
      'a.product-item-link',
      links => links.map(link => link.href)
    );

    for (const productUrl of productLinks) {
      console.log(`🔎 Visiting: ${productUrl}`);
      await page.goto(productUrl, { waitUntil: 'domcontentloaded' });

      await new Promise(resolve => setTimeout(resolve, 1000));

      function normalizeText(str) {
        if (!str || typeof str !== 'string') return str;

        return str
          .replace(/‚Ñ¢/g, '™')
          .replace(/¬Æ/g, '®')
          .replace(/‚Äì/g, '–')
          .replace(/â€™/g, "'")
          .replace(/â€œ/g, '"')
          .replace(/â€/g, '"')
          .replace(/â€¢/g, '•')
          .replace(/Â/g, '') // stray encoding
          .replace(/\uFFFD/g, '') // �
          .replace(/\[click for (more|less)...\]/gi, '')
          .replace(/[\u200B-\u200D\uFEFF]/g, '') // invisible chars
          .replace(/\r\n/g, '\n')                // normalize line endings
          .replace(/\n{2,}/g, '\n')              // collapse 2+ newlines to one
          .replace(/[ \t]+\n/g, '\n')            // remove trailing spaces before \n
          .replace(/\n[ \t]+/g, '\n')            // remove leading spaces after \n
          .trim();
      }


      // Extract product data

      const data = await page.evaluate(() => {
        const getText = (selector) => document.querySelector(selector)?.innerText.trim() || '';

        const getOptions = () => {
          const selects = document.querySelectorAll('select');
          const optionsArray = [];

          selects.forEach(select => {
            const labelEl = select.closest('.field')?.querySelector('label span');
            const label = labelEl ? labelEl.innerText.trim() : 'Option';

            const optionTexts = Array.from(select.options)
              .filter(o => o.value && o.textContent.trim() !== 'Choose an Option...')
              .map(o => o.textContent.trim());

            if (optionTexts.length > 0) {
              optionsArray.push(`${label}: ${optionTexts.join(', ')}`);
            }
          });

          return optionsArray.join(' | ');
        };

        const getFeaturesAndDescription = () => {
          const overview = document.querySelector('div.product.attribute.overview .value');
          if (!overview) return { features: '', description: '' };

          const featuresUl = overview.querySelector('ul');

          // 1. Extract <ul> feature list
          const features = featuresUl
            ? Array.from(featuresUl.querySelectorAll('li'))
                .map(li => `- ${li.textContent.trim()}`).join('\n')
            : '';

          // 2. Extract everything AFTER <ul> as description
          const descriptionParts = [];

          let node = featuresUl?.nextSibling;

          while (node) {
            if (node.nodeType === Node.TEXT_NODE) {
              const text = node.textContent.trim();
              if (text) descriptionParts.push(text);
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              const el = node;
              // Skip toggle buttons
              if (el.classList.contains('infoToggleLink')) {
                node = node.nextSibling;
                continue;
              }
              const text = el.textContent.trim();
              if (text) descriptionParts.push(text);
            }
            node = node.nextSibling;
          }

          // 3. Include .extraText (expanded content)
          const extra = overview.querySelector('.extraText')?.textContent.trim();
          if (extra) descriptionParts.push(extra);

          const description = descriptionParts.join('\n\n');

          return { features, description };
        };

        const getImages = () => {
        const imgElements = document.querySelectorAll('.fotorama__nav__frame img');
        const urls = Array.from(imgElements)
          .map(img => {
            const src = img.src.trim();
            // Replace /cache/<hash>/ with a single slash to get full-size image
            return src.replace(/\/cache\/[^/]+\//, '/');
          })
          .filter(Boolean);

        const mainImage = urls[0] || '';
        const additionalImages = urls.slice(1).join(', ');

        return { mainImage, additionalImages };
      };

        const getWhatsInTheKit = () => {
                const sections = Array.from(document.querySelectorAll('div.subSection'));
                for (const section of sections) {
                  const header = section.querySelector('h2');
                  if (header && header.textContent.trim().toLowerCase().includes("what's in the kit")) {
                    // Try both left and right containers, or anywhere in the section
                    const ul = section.querySelector('ul');
                    if (!ul) return '';
                    const items = Array.from(ul.querySelectorAll('li')).map(li => `- ${li.textContent.trim()}`);
                    return items.join('\n');
                  }
                }
                return '';
              };
     
        const getImportantNotes = () => {
          const notesContainer = document.querySelector('.ImportantNoteshighlightContainer');
          if (!notesContainer) return '';

          // Remove <br> tags and normalize line breaks
          const rawHTML = notesContainer.innerHTML
            .replace(/<br\s*\/?>/gi, '\n') // replace <br> with newline
            .replace(/<\/?[^>]+(>|$)/g, '') // strip all other HTML tags
            .trim();

          return rawHTML;
        };

       const getCompatibility = () => {
        const rows = Array.from(document.querySelectorAll('.highlightContainer table tr'));
        for (const row of rows) {
          const header = row.children[0]?.innerText?.trim().toLowerCase();
          if (header && header.includes('compatibility')) {
            return row.children[1]?.innerText?.trim() || '';
          }
        }
        return '';
      };



  



  const { features, description } = getFeaturesAndDescription();
  const { mainImage, additionalImages } = getImages();
  const kitItems = getWhatsInTheKit();
  const importantNotes = getImportantNotes();
  const compatibility = getCompatibility();




  // Then include it in the returned object:
  return {
    title: getText('h1.page-title span'),
    productCode: getText('.product.attribute.sku .value'),
    mapPrice: getText('span.old-price span.price'),
    yourPrice: getText('span.special-price span.price') || getText('span.price'),
    options: getOptions(),
    features,
    description,
    mainImage,
    additionalImages,
    kitItems,
    importantNotes,
    compatibility
  };
});

    const fixLineBreaks = (str) => str.replace(/\n/g, '\r\n');
    data.features = fixLineBreaks(data.features);
    data.description = fixLineBreaks(data.description);
    data.kitItems = fixLineBreaks(data.kitItems);
    data.importantNotes = fixLineBreaks(data.importantNotes);
    data.compatibility = fixLineBreaks(data.compatibility);


    // ✅ Clean encoding issues after evaluate
    data.title = normalizeText(data.title);
    data.productCode = normalizeText(data.productCode);
    data.mapPrice = normalizeText(data.mapPrice);
    data.yourPrice = normalizeText(data.yourPrice);
    data.options = normalizeText(data.options);
    data.features = normalizeText(data.features);
    data.description = normalizeText(data.description);
    data.kitItems = normalizeText(data.kitItems || '');
    data.kitItems = normalizeText(data.kitItems || '');
      data.kitItems = data.kitItems
        .split('\n')
        .map(line => line.replace(/^=+/, '').trim())
        .join('\n')
    data.importantNotes = normalizeText(data.importantNotes || '');
    data.compatibility = normalizeText(data.compatibility || '');







      allData.push(data);
    }
  }



  const csv = stringify(allData, {
  header: true,
  quoted: true, // <-- IMPORTANT: ensures fields with line breaks are quoted
  columns: [
    'title',
    'productCode',
    'mapPrice',
    'yourPrice',
    'options',
    'features',
    'description',
    'mainImage',
    'additionalImages',
    'kitItems',
    'importantNotes',
    'compatibility'
  ]
});


  fs.writeFileSync('metalcloak-products.csv', csv);
  console.log('\n✅ Done! Data saved to: metalcloak-products.csv');

  await browser.close();
})();


