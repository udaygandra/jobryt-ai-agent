const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function generatePdf() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error("Usage: node html-to-pdf.js <input-html-path> <output-pdf-path>");
        process.exit(1);
    }

    const inputPath = path.resolve(args[0]);
    const outputPath = path.resolve(args[1]);

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    const htmlContent = fs.readFileSync(inputPath, 'utf8');

    let browser;
    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        // Wait for fonts/images to load
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        
        await page.pdf({
            path: outputPath,
            format: 'Letter',
            printBackground: true,
            margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
        });
        
        console.log(`Successfully created PDF: ${outputPath}`);
    } catch (error) {
        console.error("Failed to generate PDF:", error);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
}

generatePdf();
