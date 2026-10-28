const fs = require('fs');
const path = require('path');

const inputPath = path.join(__dirname, 'urls.txt');
const outputPrefix = path.join(__dirname, 'urls-');
const numberOfFiles = 32;

try {
  const content = fs.readFileSync(inputPath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  const chunkSize = Math.ceil(lines.length / numberOfFiles);

  for (let i = 0; i < numberOfFiles; i++) {
    const chunk = lines.slice(i * chunkSize, (i + 1) * chunkSize);
    const filePath = `${outputPrefix}${i + 1}.txt`;
    fs.writeFileSync(filePath, chunk.join('\n'), 'utf-8');
    console.log(`✅ Written: ${filePath}`);
  }

  console.log('🎉 Split complete!');
} catch (error) {
  console.error('❌ Error splitting the file:', error);
}
